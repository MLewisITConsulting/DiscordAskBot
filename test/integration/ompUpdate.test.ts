import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import { createWorkerDispatcher, type WorkerDispatcher } from "../../src/orchestrator/dispatch/workers";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import type { CopyInstaller } from "../../src/orchestrator/omp/runtime";
import { createOmpUpdater, type InstallResult, type OmpUpdater, UNSUPPORTED } from "../../src/orchestrator/omp/updates";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { ensureOmpAssetsDir, skillsBundle } from "../../src/orchestrator/store/ompAssets";
import { openSignins, type Signins } from "../../src/orchestrator/store/signins";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import { AUTO_UPDATE_BY } from "../../src/shared/adminOmp";
import { parseSettings } from "../../src/shared/config";
import { setLogSink } from "../../src/shared/log";
import { OMP_PACKAGE } from "../../src/shared/ompPins";
import { workerRoot } from "../../src/worker/status";
import { createFakeDiscord, type FakeDiscord } from "../fakes/discord";
import { TEST_IDENTITY } from "../fakes/ompUpdates";

/**
 * Phase 8 exit (implementation.md §4, requirements UPD-02 to UPD-05, architecture UPD-06 to UPD-10): approving an omp
 * update makes the next worker use the new omp while a running worker keeps the image's; a broken copy falls back within
 * the run and offers the update again; `omp.autoUpdate` installs without an approval and never retries a failed version
 * by itself; outside the image updates are refused. The real controller, worker dispatcher, internal API and worker
 * processes (`test/fixtures/worker-process.ts`), fake Discord, a fake npm registry, and an injected installer whose tree
 * the real updater checks, packs, serves and the worker unpacks. The web approval itself is in `omp.test.ts`.
 */

const WORKER_TOKEN = "upd-worker-token";
const SCALE_TOKEN = "upd-scale-token";
const ASK = "ask-channel";
const ALICE = "u-alice";
const IMAGE_OMP = "18.12.1";
const NEW_OMP = "99.1.0";
const WORKER_PROCESS = join(import.meta.dir, "..", "fixtures", "worker-process.ts");
const FIXTURE_HOST = join(import.meta.dir, "..", "fixtures", "agent-host.ts");
/** The worker fixture announces this omp version for the image's omp. */
const WORKER_IMAGE_OMP = "test";
const BROKEN_STDERR = "SyntaxError: Export named 'createAgentSession' not found in module";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Polls for a state reached by other OS processes (the workers and their hosts) over real I/O: there is no event to await. */
async function until(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

/**
 * Writes the tree the real installer would: a host entry, `package.json`, `bun.lock` and omp's `package.json`. A good
 * copy's host is the fixture agent host; a broken one exits before it registers, like an omp that fails to load.
 */
function fakeInstaller(h: Harness["install"]): CopyInstaller {
	return async ({ dir, version }) => {
		h.calls.push(version);
		await h.gate;
		if (h.copy === "failing") return { output: `npm ERR! 404 ${OMP_PACKAGE}@${version} not found\n`, error: "bun install failed (exit 1)" };
		mkdirSync(join(dir, "src", "worker", "host"), { recursive: true });
		const host =
			h.copy === "good"
				? `await import(${JSON.stringify(FIXTURE_HOST)});\n`
				: `process.stderr.write(${JSON.stringify(`${BROKEN_STDERR}\n`)});\nprocess.exit(3);\n`;
		writeFileSync(join(dir, "src", "worker", "host", "host.ts"), host);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [OMP_PACKAGE]: version } }));
		writeFileSync(join(dir, "bun.lock"), "lock");
		mkdirSync(join(dir, "node_modules", OMP_PACKAGE), { recursive: true });
		writeFileSync(join(dir, "node_modules", OMP_PACKAGE, "package.json"), JSON.stringify({ name: OMP_PACKAGE, version }));
		return { output: `installed ${OMP_PACKAGE}@${version}\n` };
	};
}

interface Worker {
	proc: Subprocess<"ignore", "pipe", "pipe">;
	root: string;
	stderr: Promise<string>;
	exited: Promise<number>;
}

interface Harness {
	stateDir: string;
	runtimeDir: string | undefined;
	discord: FakeDiscord;
	db: Db;
	updater: OmpUpdater;
	dispatcher: WorkerDispatcher;
	/** What the fake npm registry answers as `latest`. */
	registry: { latest: string };
	install: { copy: "good" | "broken" | "failing"; gate?: Promise<void>; /** The versions the installer was asked for, in order. */ calls: string[] };
	vault: Vault;
	controller: Controller;
	/** Saves the settings with `omp.autoUpdate` and re-applies the engine, as a settings save does. */
	setAutoUpdate(on: boolean): Promise<void>;
	/** Approves `version` as the admin would (UPD-03); throws when refused. */
	approve(version: string): Promise<InstallResult>;
	spawnWorker(): Worker;
}

async function boot(opts: { inImage?: boolean; autoUpdate?: boolean } = {}): Promise<Harness> {
	const stateDir = await mkdtemp(join(tmpdir(), "askbot-upd-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	setLogSink(() => {});
	cleanups.push(() => setLogSink(undefined));
	const ompDir = join(stateDir, "omp");
	await ensureOmpAssetsDir(ompDir);
	const discord = createFakeDiscord({ guildId: "g1", channels: [{ id: ASK, name: "ask" }] });
	const registry = { latest: NEW_OMP };
	const npm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ name: OMP_PACKAGE, version: registry.latest }) });
	cleanups.push(() => npm.stop(true));

	const db = openDb(dbPath(stateDir));
	const vault = await openVault(db, Buffer.from(crypto.randomUUID() + crypto.randomUUID(), "utf8"));
	await vault.initialize("admin", "correct horse battery");
	const settingsInput = (autoUpdate: boolean) =>
		parseSettings({
			config: {
				discord: { guildId: "g1", allowedUserIds: [ALICE], askChannelIds: [ASK] },
				omp: { autoUpdate },
			},
			secrets: { discordToken: "discord-token" },
		});
	vault.writeSettings(settingsInput(opts.autoUpdate ?? false));
	const settings = () => vault.readSettings();
	const signins: Signins = await openSignins(stateDir);
	const install: Harness["install"] = { copy: "good", calls: [] };
	const runtimeDir = opts.inImage === false ? undefined : join(stateDir, "omp-runtime");
	const updater = createOmpUpdater({
		db,
		runtimeDir,
		identity: TEST_IDENTITY,
		imageOmpVersion: IMAGE_OMP,
		imageAppDir: stateDir,
		installer: (p => fakeInstaller(install)(p)) satisfies CopyInstaller,
		registryUrl: npm.url.href,
		autoUpdate: () => settings()?.config.omp.autoUpdate ?? false,
	});
	updater.start();
	const dispatcher = createWorkerDispatcher({
		db,
		stateDir,
		// Every worker here connects from 127.0.0.1 (architecture §6 address binding is tested in dispatch.test.ts).
		bindWorkerAddresses: false,
		limits: () => ({ maxChatSessions: 2, maxConcurrentRuns: 4 }),
		reattachGraceMs: 10_000,
		spec: {
			stateDir,
			ompConfig: () => vault.readOmpConfig(),
			providerKeys: () => settings()?.secrets.providerKeys ?? {},
			credentials: () => signins.snapshotForRun(),
			skillsHash: async () => (await skillsBundle(ompDir)).hash,
		},
		skills: () => skillsBundle(ompDir),
		credentialRequest: req => signins.handleCredentialRequest(req),
		leaseMs: 1_500,
		sweepMs: 50,
		ompRuntime: updater,
	});
	let controller: Controller | undefined;
	const api: InternalApi = startInternalApi({
		host: "127.0.0.1",
		port: 0,
		stateDir,
		db,
		version: TEST_IDENTITY.version,
		workerCapacity: 4,
		phase: () => controller?.status().phase ?? "starting",
		config: () => settings()?.config,
		dispatcher,
		admin: { handle: async () => new Response("admin") },
		workers: dispatcher,
		workerToken: WORKER_TOKEN,
		scaleToken: SCALE_TOKEN,
	});
	controller = createController({
		stateDir,
		ompDir,
		db,
		vault,
		agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
		dispatcher,
		connectDiscord: () => discord,
	});
	await controller.apply();
	expect(controller.status()).toMatchObject({ phase: "running" });

	const workers: Worker[] = [];
	cleanups.push(async () => {
		await api.stop();
		dispatcher.close();
		updater.stop();
		await controller.stop();
		signins.close();
		for (const w of workers) {
			const children = Bun.spawnSync(["pgrep", "-P", String(w.proc.pid)]).stdout.toString().split("\n").filter(Boolean).map(Number);
			w.proc.kill("SIGKILL");
			for (const pid of children) {
				for (const target of [-pid, pid]) {
					try {
						process.kill(target, "SIGKILL");
					} catch {}
				}
			}
			await w.exited;
			await rm(w.root, { recursive: true, force: true });
		}
		db.close();
	});
	return {
		stateDir,
		runtimeDir,
		discord,
		db,
		updater,
		dispatcher,
		registry,
		install,
		vault,
		controller,
		async setAutoUpdate(on) {
			vault.writeSettings(settingsInput(on));
			await controller.apply();
		},
		approve(version) {
			const start = updater.install(version, "admin");
			if (!start.started) throw new Error(start.error);
			return start.done;
		},
		spawnWorker() {
			const proc = Bun.spawn(["bun", WORKER_PROCESS], {
				env: { ...process.env, ASKBOT_ORCHESTRATOR_URL: api.url, TEST_WORKER_TOKEN: WORKER_TOKEN },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			void new Response(proc.stdout).text();
			const w: Worker = { proc, root: workerRoot(join(tmpdir(), "askbot-worker"), proc.pid), stderr: new Response(proc.stderr).text(), exited: proc.exited };
			workers.push(w);
			return w;
		},
	};
}

const alice = (h: Harness) => h.discord.actor(ALICE, { username: "alice" });

async function ask(h: Harness, prompt: string): Promise<string> {
	const e = await h.discord.emitCommand({ command: "ask", options: { prompt }, attachments: [], actor: alice(h), channelId: ASK });
	const threadId = /<#(\d+)>/.exec(e.responses.find(r => r.type === "editReply")?.msg?.content ?? "")?.[1];
	if (!threadId) throw new Error(`no thread started: ${JSON.stringify(e.responses)}`);
	return threadId;
}

const said = (h: Harness, channelId: string, text: string) => h.discord.messages(channelId).filter(m => m.content.includes(text));

/** A held `/ask` run on its own worker, `registered` (state `running`). */
async function heldRun(h: Harness, label: string): Promise<{ threadId: string; runId: string; worker: Worker }> {
	const threadId = await ask(h, `fixture:chatHeld ${label}`);
	const worker = h.spawnWorker();
	await until(() => h.db.currentRun(threadId)?.state === "running", `${label} to run`);
	return { threadId, runId: h.db.currentRun(threadId)!.id, worker };
}

async function finish(h: Harness, run: { threadId: string; worker: Worker }): Promise<void> {
	await h.discord.emitMessage({ channelId: run.threadId, content: "please finish now", actor: alice(h) });
	await until(() => said(h, run.threadId, "✅ **Done.**").length === 1, "the chat to finish");
	expect(await run.worker.exited).toBe(0);
	expect(existsSync(run.worker.root)).toBe(false);
}

describe("in-place omp updates for workers (phase 8)", () => {
	test("approve: a running worker keeps the image's omp, the next downloads the copy; stale and concurrent approvals are refused", async () => {
		const h = await boot();
		const first = await heldRun(h, "before the update");
		expect(h.db.getRun(first.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);

		// UPD-02: the check finds a newer omp and stores it; nothing is posted and, with autoUpdate off, nothing installs.
		const messages = h.discord.messages(ASK).length;
		await h.updater.check();
		expect(h.updater.status()).toMatchObject({ latest: NEW_OMP, available: NEW_OMP, autoUpdate: false });
		await h.discord.settled();
		expect(h.discord.messages(ASK)).toHaveLength(messages);
		expect(h.install.calls).toEqual([]);

		// UPD-03: a second approval while the first installs is refused.
		const release = Promise.withResolvers<void>();
		h.install.gate = release.promise;
		const approving = h.approve(NEW_OMP);
		expect(h.updater.status().installing).toMatchObject({ version: NEW_OMP, by: "admin" });
		expect(h.updater.install(NEW_OMP, "other")).toEqual({ started: false, error: `omp ${NEW_OMP} is already being installed (approved by admin)` });
		release.resolve();
		expect(await approving).toMatchObject({ ok: true });
		const active = h.updater.status().active!;
		expect(active).toMatchObject({ version: NEW_OMP, by: "admin" });
		expect(h.updater.status().attempt).toMatchObject({ version: NEW_OMP, from: IMAGE_OMP, by: "admin", outcome: "installed" });
		expect(existsSync(join(h.runtimeDir!, active.copy, "runtime.tar.gz"))).toBe(true);
		expect(existsSync(join(h.runtimeDir!, active.copy, "app"))).toBe(false);
		expect(h.updater.status().available).toBeUndefined();

		// A stale approval (the update is installed now) is refused.
		expect(h.updater.install(NEW_OMP, "admin")).toEqual({ started: false, error: `omp ${NEW_OMP} is no longer the update on offer` });

		// The running worker already chose; the next one downloads the copy and reports its version (UPD-07).
		const second = await heldRun(h, "after the update");
		expect(h.db.getRun(second.runId)?.omp_version).toBe(NEW_OMP);
		expect(h.db.getRun(first.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);
		expect(readdirSync(join(second.worker.root, "omp-runtime"))).toEqual(expect.arrayContaining(["node_modules", "src", "package.json", "bun.lock"]));
		await finish(h, first);
		await finish(h, second);
		expect(h.db.getRun(second.runId)).toMatchObject({ state: "finished", outcome: "succeeded", omp_version: NEW_OMP });
	}, 40_000);

	test("a broken copy: the worker falls back to the image's omp in the same run; the copy is failed and the update offered again (UPD-08)", async () => {
		const h = await boot();
		h.install.copy = "broken";
		await h.updater.check();
		await h.approve(NEW_OMP);
		const copy = h.updater.status().active!.copy;

		const run = await heldRun(h, "on the canary");
		// run-info came twice: the copy's version, then the image's after the fallback.
		expect(h.db.getRun(run.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);
		expect(h.updater.status().active).toBeUndefined();
		expect(h.updater.status().attempt).toMatchObject({ version: NEW_OMP, outcome: "failed", copy, by: "admin" });
		expect(h.updater.status().attempt?.error).toContain(`the agent host from omp ${NEW_OMP} exited with code 3 before it registered`);
		expect(h.updater.status().attempt?.log).toContain(BROKEN_STDERR);
		// Offered again for a fresh approval.
		expect(h.updater.status().available).toBe(NEW_OMP);

		// The run goes on with the image's omp, once (no second fallback).
		await finish(h, run);
		expect(h.db.getRun(run.runId)).toMatchObject({ state: "finished", outcome: "succeeded" });
		expect(await run.worker.stderr).toContain(BROKEN_STDERR);

		// The failed copy is deleted once no assigned run may still download it (UPD-09).
		await until(() => !existsSync(join(h.runtimeDir!, copy)), "the failed copy to be deleted");

		// The next run uses the image's omp straight away.
		const next = await heldRun(h, "after the failure");
		expect(h.db.getRun(next.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);
		await finish(h, next);
	}, 40_000);

	test("outside the image updates are refused (UPD-05)", async () => {
		const h = await boot({ inImage: false, autoUpdate: true });
		const view = await h.updater.check();
		expect(view).toMatchObject({ supported: false, unsupportedReason: UNSUPPORTED, latest: NEW_OMP, available: NEW_OMP });
		expect(h.updater.install(NEW_OMP, "admin")).toEqual({ started: false, error: UNSUPPORTED });
		expect(h.updater.status().attempt).toBeUndefined();
		expect(h.install.calls).toEqual([]);
		expect(h.updater.forRun("any")).toBeUndefined();
	}, 20_000);

	test("auto-update on: the check installs at once, recorded as auto-update; new workers use the copy (UPD-02, UPD-03)", async () => {
		const h = await boot({ autoUpdate: true });
		const first = await heldRun(h, "before the update");
		expect(h.db.getRun(first.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);

		await h.updater.check();
		await until(() => h.updater.status().active !== undefined, "the automatic install");
		expect(h.install.calls).toEqual([NEW_OMP]);
		expect(h.updater.status().active).toMatchObject({ version: NEW_OMP, by: AUTO_UPDATE_BY });
		expect(h.updater.status().attempt).toMatchObject({ version: NEW_OMP, outcome: "installed", by: AUTO_UPDATE_BY });
		expect(h.updater.status().available).toBeUndefined();

		// New workers use the copy; the running one keeps the image's omp.
		const next = await heldRun(h, "after the update");
		expect(h.db.getRun(next.runId)?.omp_version).toBe(NEW_OMP);
		expect(h.db.getRun(first.runId)?.omp_version).toBe(WORKER_IMAGE_OMP);
		await finish(h, first);
		await finish(h, next);
	}, 40_000);

	test("auto-update on, the install fails: the failure keeps its output, is not retried automatically, and an approval retries it (UPD-03)", async () => {
		const h = await boot({ autoUpdate: true });
		h.install.copy = "failing";
		await h.updater.check();
		await until(() => h.updater.status().attempt?.outcome === "failed", "the failed install");
		expect(h.updater.status().attempt).toMatchObject({ version: NEW_OMP, by: AUTO_UPDATE_BY, error: "bun install failed (exit 1)" });
		expect(h.updater.status().attempt?.log).toContain(`npm ERR! 404 ${OMP_PACKAGE}@${NEW_OMP} not found`);
		expect(h.updater.status().active).toBeUndefined();

		// The same version is not installed again by the next check.
		await h.updater.check();
		expect(h.install.calls).toEqual([NEW_OMP]);
		expect(h.updater.status().installing).toBeUndefined();

		// An approval is the manual retry.
		h.install.copy = "good";
		expect(await h.approve(NEW_OMP)).toMatchObject({ ok: true });
		expect(h.install.calls).toEqual([NEW_OMP, NEW_OMP]);
		expect(h.updater.status().active).toMatchObject({ version: NEW_OMP, by: "admin" });
	}, 30_000);

	test("auto-update on, the copy fails its canary run: the version is not installed again automatically (UPD-08)", async () => {
		const h = await boot({ autoUpdate: true });
		h.install.copy = "broken";
		await h.updater.check();
		await until(() => h.updater.status().active !== undefined, "the automatic install");
		const run = await heldRun(h, "on the canary");
		expect(h.updater.status().active).toBeUndefined();
		expect(h.updater.status().attempt).toMatchObject({ version: NEW_OMP, outcome: "failed", by: AUTO_UPDATE_BY });
		await h.updater.check();
		expect(h.install.calls).toEqual([NEW_OMP]);
		await finish(h, run);
	}, 40_000);

	test("an orchestrator restart during an install records it as failed, and it is not installed again automatically (UPD-03)", async () => {
		const h = await boot();
		h.db.kvSet("omp.update.latest", NEW_OMP);
		h.db.kvSet("omp.update.attempt", JSON.stringify({ version: NEW_OMP, from: IMAGE_OMP, by: AUTO_UPDATE_BY, outcome: "installing", at: new Date().toISOString() }));
		const restarted = createOmpUpdater({
			db: h.db,
			runtimeDir: join(h.stateDir, "omp-runtime-restarted"),
			identity: TEST_IDENTITY,
			imageOmpVersion: IMAGE_OMP,
			imageAppDir: h.stateDir,
			installer: (p => fakeInstaller(h.install)(p)) satisfies CopyInstaller,
			registryUrl: "http://127.0.0.1:1/",
			autoUpdate: () => true,
		});
		cleanups.push(() => restarted.stop());
		expect(restarted.status().attempt).toMatchObject({ version: NEW_OMP, outcome: "failed", error: "the orchestrator restarted during the install" });
		await restarted.check();
		expect(h.install.calls).toEqual([]);
	}, 20_000);

	test("turning auto-update off mid-install does not cancel it", async () => {
		const h = await boot({ autoUpdate: true });
		const release = Promise.withResolvers<void>();
		h.install.gate = release.promise;
		await h.updater.check();
		expect(h.updater.status().installing).toMatchObject({ version: NEW_OMP, by: AUTO_UPDATE_BY });

		await h.setAutoUpdate(false);
		expect(h.updater.status()).toMatchObject({ autoUpdate: false, installing: { version: NEW_OMP } });
		release.resolve();
		await until(() => h.updater.status().active !== undefined, "the install to finish");
		expect(h.updater.status().active).toMatchObject({ version: NEW_OMP, by: AUTO_UPDATE_BY });
		expect(h.install.calls).toEqual([NEW_OMP]);
	}, 30_000);

	test("concurrent checks start one install; a newer omp found during it is installed once it finishes", async () => {
		const h = await boot({ autoUpdate: true });
		const release = Promise.withResolvers<void>();
		h.install.gate = release.promise;
		await Promise.all([h.updater.check(), h.updater.check()]);
		expect(h.updater.status().installing).toMatchObject({ version: NEW_OMP });
		h.registry.latest = "99.2.0";
		await h.updater.check();
		expect(h.install.calls).toEqual([NEW_OMP]);
		h.install.gate = undefined;
		release.resolve();
		await until(() => h.updater.status().active?.version === "99.2.0", "the second install");
		expect(h.install.calls).toEqual([NEW_OMP, "99.2.0"]);
		expect(h.updater.status().attempt).toMatchObject({ version: "99.2.0", from: NEW_OMP, outcome: "installed", by: AUTO_UPDATE_BY });
	}, 30_000);
});
