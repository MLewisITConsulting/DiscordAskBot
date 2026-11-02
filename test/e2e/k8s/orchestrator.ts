// The orchestrator of the e2e scenario image (test/e2e/k8s/Containerfile): `src/orchestrator/main.ts`'s wiring — the
// real internal API (health, worker WebSocket, scale, run artifacts), worker dispatcher, engine and admin API, with the
// mounted token files and env read exactly like the real one — but with the fake Discord (`test/fakes/discord.ts`)
// in-process and the e2e settings (one ask channel, one allowed user) seeded into the vault. So the chart and compose.yaml
// run it unchanged, and workers, KEDA, the launcher, web and the probes see the real product; only Discord and the model
// (the fixture agent host the scenario image's workers run) are fake.
//
// First start: as the real orchestrator, it logs a setup token and waits for the admin account (web /setup, WEB-02);
// the settings are seeded at the first engine apply after that. With E2E_ADMIN_PASSWORD the vault is initialised at
// start with it (user `admin`) instead, for drivers that skip the web UI. Once the vault is open, every start seeds
// the settings again (limits from env), so a restart keeps the e2e configuration.
//
// Env (all optional):
//   E2E_ADMIN_PASSWORD      initialise the vault at start (no setup token)
//   E2E_MAX_CHAT_SESSIONS   limits.maxChatSessions (default 2, the product default)
//   E2E_LEASE_MS            run lease (default LEASE_MS, 45 s): how long a vanished worker takes to count as lost
//   E2E_SWEEP_MS            how often expired leases are swept (default 1 s)
//   E2E_REATTACH_GRACE_MS   re-attach grace after a restart (default workers.reattachGraceSeconds)
//   E2E_DISCORD_STATE       keep the fake Discord's channels and messages in this file across restarts (chaos)
//
// The driver's control API sits under `/internal/admin/e2e/`, guarded by the web token like the rest of
// `/internal/admin/`:
//   POST e2e/ask      {prompt, user?}           `/ask prompt` in the ask channel (the prompt may carry fixture markers);
//                                                {thread, reply}: the new thread, or null and the refusal
//   POST e2e/message  {thread, content, user?}  a user message in the thread (a follow-up, or steering the live run)
//   POST e2e/stop     {thread, user?}           `/stop` in the thread; {reply}
//   POST e2e/limits   {maxChatSessions}         saves the settings and restarts the engine
//   GET  e2e/threads                            the ask threads with their messages
//   GET  e2e/state                              engine phase, limits, pending runs and every run
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { createAdminApi, generateSetupToken, loadWebApiToken } from "../../../src/orchestrator/api/admin";
import { createAdminFeatures } from "../../../src/orchestrator/api/features";
import { loadInternalToken, startInternalApi } from "../../../src/orchestrator/api/server";
import type { ReplyOptions } from "../../../src/orchestrator/discord/surface";
import { sameToken } from "../../../src/orchestrator/dispatch/leases";
import { createWorkerDispatcher, dispatchLimits } from "../../../src/orchestrator/dispatch/workers";
import { type Controller, createController } from "../../../src/orchestrator/engine/controller";
import { createOmpUpdater } from "../../../src/orchestrator/omp/updates";
import { openAgentLog } from "../../../src/orchestrator/store/agentlog";
import { dbPath, openDb } from "../../../src/orchestrator/store/db";
import { ensureOmpAssetsDir, skillsBundle } from "../../../src/orchestrator/store/ompAssets";
import { openSignins } from "../../../src/orchestrator/store/signins";
import { loadMasterKey, openVault } from "../../../src/orchestrator/store/vault";
import { ADMIN_PREFIX } from "../../../src/shared/adminApi";
import { parseSettings } from "../../../src/shared/config";
import { loadEnv } from "../../../src/shared/env";
import { errorMessage, log, setLogSink } from "../../../src/shared/log";
import { installedOmpVersion } from "../../../src/shared/ompPins";
import { openRollingFiles } from "../../../src/shared/rollinglog";
import { APP_ROOT, appIdentity, versionInfo } from "../../../src/shared/version";
import { createFakeDiscord, type FakeResponse } from "../../fakes/discord";

const GUILD = "e2e-guild";
const ASK_CHANNEL = "e2e-ask";
const ADMIN_USER = "e2e-admin";
const CONTROL_PREFIX = `${ADMIN_PREFIX}/e2e/`;
const ALL_RUN_STATES = ["pending", "assigned", "running", "finishing", "finished", "lost"] as const;

const env = loadEnv();
const seededChatSessions = Number(process.env.E2E_MAX_CHAT_SESSIONS || 2);
const optionalMs = (name: string): number | undefined => (process.env[name] ? Number(process.env[name]) : undefined);

await mkdir(join(env.stateDir, "logs", "orchestrator"), { recursive: true });
const processLog = openRollingFiles({ dir: join(env.stateDir, "logs", "orchestrator"), prefix: "orchestrator" });
setLogSink(line => processLog.append(line));
const db = openDb(dbPath(env.stateDir));
const agentLog = await openAgentLog({ dir: join(env.stateDir, "logs", "agent") });
const vault = await openVault(db, await loadMasterKey(env.masterKeyFile));
const { askbot: version } = await versionInfo();

const discord = createFakeDiscord({
	guildId: GUILD,
	channels: [{ id: ASK_CHANNEL, name: "ask" }],
	persistFile: process.env.E2E_DISCORD_STATE || undefined,
});

if (!vault.isInitialized() && process.env.E2E_ADMIN_PASSWORD) await vault.initialize("admin", process.env.E2E_ADMIN_PASSWORD);
if (vault.isInitialized() && !vault.isUnlocked()) throw new Error("the vault is locked: is ASKBOT_MASTER_KEY_FILE the key it was initialised with?");

const settings = () => {
	try {
		return vault.isUnlocked() ? vault.readSettings() : undefined;
	} catch {
		return undefined;
	}
};
function writeSettings(maxChatSessions: number): void {
	vault.writeSettings(
		parseSettings({
			config: { discord: { guildId: GUILD, allowedUserIds: [ADMIN_USER], askChannelIds: [ASK_CHANNEL] }, limits: { maxChatSessions } },
			secrets: { discordToken: "e2e-discord-token" },
		}),
	);
	log("info", "e2e settings seeded", { maxChatSessions });
}
if (vault.isUnlocked()) writeSettings(seededChatSessions);

const signins = await openSignins(env.stateDir);
await ensureOmpAssetsDir(env.ompDir);
// Never started: no npm checks from a test; workers get the image's omp (the fixture host does not load it anyway).
const ompUpdates = createOmpUpdater({
	db,
	runtimeDir: env.ompRuntimeDir,
	identity: await appIdentity(),
	imageOmpVersion: installedOmpVersion(APP_ROOT),
	imageAppDir: APP_ROOT,
});
const dispatcher = createWorkerDispatcher({
	db,
	stateDir: env.stateDir,
	limits: () => dispatchLimits(settings()?.config, env.workerCapacity),
	reattachGraceMs: optionalMs("E2E_REATTACH_GRACE_MS") ?? (settings()?.config.workers.reattachGraceSeconds ?? 90) * 1000,
	leaseMs: optionalMs("E2E_LEASE_MS"),
	sweepMs: optionalMs("E2E_SWEEP_MS"),
	spec: {
		stateDir: env.stateDir,
		ompConfig: () => vault.readOmpConfig(),
		providerKeys: () => settings()?.secrets.providerKeys ?? {},
		credentials: () => signins.snapshotForRun(),
		skillsHash: async () => (await skillsBundle(env.ompDir)).hash,
	},
	skills: () => skillsBundle(env.ompDir),
	credentialRequest: req => signins.handleCredentialRequest(req),
	ompRuntime: ompUpdates,
	bindWorkerAddresses: env.workerAddressBinding,
});
const engine = createController({ stateDir: env.stateDir, ompDir: env.ompDir, db, vault, agentLog, dispatcher, connectDiscord: () => discord });
// The first apply after /setup (the admin account just created, the vault open) seeds the settings.
const controller: Controller = {
	...engine,
	async apply() {
		if (vault.isUnlocked() && !settings()) writeSettings(seededChatSessions);
		await engine.apply();
	},
};

const setupToken = vault.isInitialized() ? undefined : generateSetupToken();
const features = createAdminFeatures({ vault, signins, agentLog, processLog, stateDir: env.stateDir, ompDir: env.ompDir, ompUpdates });
const webToken = await loadWebApiToken(env.webApiTokenFile);
const adminApi = createAdminApi({
	db,
	vault,
	controller,
	dispatcher,
	version,
	workerCapacity: env.workerCapacity,
	webToken,
	setupToken,
	routes: features.routes,
	modelAccounts: features.modelAccounts,
	checkChannels: features.checkChannels,
});

/** Every run state change seen, logged as `e2e run transition`: the evidence the drivers print. */
const lastSeen = new Map<string, string>();
const recorder = setInterval(() => {
	try {
		for (const run of db.runsInState(...ALL_RUN_STATES)) {
			const key = `${run.state}/${run.outcome ?? ""}/${run.worker_id ?? ""}`;
			if (lastSeen.get(run.id) === key) continue;
			lastSeen.set(run.id, key);
			log("info", "e2e run transition", { run: run.id, thread: run.thread_id, state: run.state, outcome: run.outcome ?? undefined, worker: run.worker_id ?? undefined });
		}
	} catch (err) {
		log("warn", "e2e transition recorder failed", { error: errorMessage(err) });
	}
}, 250);

interface ControlBody {
	prompt?: string;
	user?: string;
	thread?: string;
	content?: string;
	maxChatSessions?: number;
}

const actor = (userId: string | undefined) => discord.actor(userId || ADMIN_USER, { username: userId || ADMIN_USER });
/** The text of an interaction's last reply or edit. */
const replyText = (responses: FakeResponse[]) => {
	const msg: ReplyOptions | undefined = responses.findLast(r => r.msg)?.msg;
	return msg?.content ?? null;
};

function threadsView() {
	return discord
		.channels()
		.filter(c => c.kind === "thread" && c.parentId === ASK_CHANNEL)
		.map(c => ({
			id: c.id,
			name: c.name,
			owner: db.getAskChat(c.id)?.owner_id ?? null,
			messages: discord.messages(c.id).map(m => {
				const answer = m.files.find(f => f.name === "answer.md")?.data;
				return {
					id: m.id,
					bot: m.authorId === discord.botUserId,
					content: m.content,
					files: m.files.map(f => f.name),
					// The attached answer's text; gone after a restart with E2E_DISCORD_STATE (only file names persist).
					answer: answer === undefined ? null : typeof answer === "string" ? answer : new TextDecoder().decode(answer),
					edits: m.edits,
				};
			}),
		}));
}

async function control(req: Request, path: string): Promise<Response> {
	const body: ControlBody = req.method === "POST" ? ((await req.json()) as ControlBody) : {};
	if (req.method === "POST" && path === "ask") {
		const before = new Set(discord.channels().map(c => c.id));
		const { responses } = await discord.emitCommand({ command: "ask", options: { prompt: body.prompt ?? "" }, actor: actor(body.user), channelId: ASK_CHANNEL });
		const thread = discord.channels().find(c => c.kind === "thread" && c.parentId === ASK_CHANNEL && !before.has(c.id))?.id ?? null;
		log("info", "e2e ask", { thread: thread ?? undefined, user: body.user || ADMIN_USER });
		return Response.json({ thread, reply: replyText(responses) });
	}
	if (req.method === "POST" && path === "message") {
		if (!body.thread || !discord.channels().some(c => c.id === body.thread)) return Response.json({ error: "no such thread" }, { status: 404 });
		const { ref } = await discord.emitMessage({ channelId: body.thread, content: body.content ?? "", actor: actor(body.user) });
		return Response.json({ message: ref?.messageId ?? null });
	}
	if (req.method === "POST" && path === "stop") {
		if (!body.thread || !discord.channels().some(c => c.id === body.thread)) return Response.json({ error: "no such thread" }, { status: 404 });
		const { responses } = await discord.emitCommand({ command: "stop", actor: actor(body.user), channelId: body.thread });
		return Response.json({ reply: replyText(responses) });
	}
	if (req.method === "POST" && path === "limits") {
		const maxChatSessions = body.maxChatSessions ?? settings()?.config.limits.maxChatSessions ?? seededChatSessions;
		writeSettings(maxChatSessions);
		await engine.apply();
		log("info", "e2e limits saved", { maxChatSessions, phase: engine.status().phase });
		return Response.json({ limits: { maxChatSessions }, phase: engine.status().phase });
	}
	if (req.method === "GET" && path === "threads") return Response.json(threadsView());
	if (req.method === "GET" && path === "state") {
		return Response.json({
			phase: engine.status().phase,
			pendingRuns: dispatcher.pendingRuns(),
			limits: dispatchLimits(settings()?.config, env.workerCapacity) ?? null,
			runs: db.runsInState(...ALL_RUN_STATES).map(r => ({
				id: r.id,
				thread: r.thread_id,
				state: r.state,
				outcome: r.outcome,
				error: r.error,
				worker: r.worker_id,
				continues: r.continues_run_id,
				createdAt: r.created_at,
				claimedAt: r.claimed_at,
				startedAt: r.started_at,
				finishedAt: r.finished_at,
			})),
		});
	}
	return Response.json({ error: "not found" }, { status: 404 });
}

const api = startInternalApi({
	host: env.internalHost,
	port: env.internalPort,
	stateDir: env.stateDir,
	db,
	version,
	workerCapacity: env.workerCapacity,
	phase: () => engine.status().phase,
	config: () => settings()?.config,
	dispatcher,
	admin: {
		async handle(req) {
			const { pathname } = new URL(req.url);
			if (!pathname.startsWith(CONTROL_PREFIX)) return adminApi.handle(req);
			const auth = req.headers.get("authorization") ?? "";
			if (!webToken || !auth.startsWith("Bearer ") || !sameToken(auth.slice(7).trim(), webToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
			try {
				return await control(req, pathname.slice(CONTROL_PREFIX.length));
			} catch (err) {
				log("error", "e2e control request failed", { path: pathname, error: errorMessage(err) });
				return Response.json({ error: errorMessage(err) }, { status: 500 });
			}
		},
	},
	workers: dispatcher,
	workerToken: await loadInternalToken(env.workerTokenFile, "ASKBOT_WORKER_TOKEN_FILE", "the worker WebSocket"),
	scaleToken: await loadInternalToken(env.scaleTokenFile, "ASKBOT_SCALE_TOKEN_FILE", "the scale endpoint"),
});
log("info", "e2e orchestrator started", { url: api.url, version, workerCapacity: env.workerCapacity, maxChatSessions: seededChatSessions });
if (setupToken) log("info", "first run: open the web UI's /setup page and enter this setup token to create the admin account", { setupToken });

postmortem.register(
	"askbot-e2e-orchestrator-shutdown",
	async reason => {
		log("info", "shutting down", { reason });
		clearInterval(recorder);
		await api.stop();
		dispatcher.close();
		await engine.stop();
		signins.close();
		db.close();
		setLogSink(undefined);
	},
	{ exitOnly: true },
);

await controller.apply();
log("info", "startup complete", { phase: engine.status().phase });
