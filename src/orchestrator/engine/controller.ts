import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EnginePhase, StatusReport } from "../../shared/adminApi";
import { ASK_CHANNEL_MISSING, type Config, hasAskChannel, type Settings } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import { attachBot } from "../discord/bot";
import { createDiscordJsConnection } from "../discord/discordjs";
import type { DiscordConnection } from "../discord/surface";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { AgentLog } from "../store/agentlog";
import type { Db } from "../store/db";
import type { Vault } from "../store/vault";
import { createAskChat } from "./chat";
import type { EngineDeps } from "./deps";

export type { EnginePhase };

export interface EngineStatus {
	phase: EnginePhase;
	/** Startup error of the last apply, or why the engine is `unconfigured`. */
	error?: string;
	since: string;
}

/** Point-in-time view of a running engine for the status page. */
export type EngineSnapshot = NonNullable<StatusReport["engine"]>;

export interface Controller {
	status(): EngineStatus;
	/** ENG-02: stops any running engine and starts one with the vault's current settings. Never throws; failures land in status(). */
	apply(): Promise<void>;
	/**
	 * Orchestrator shutdown (ENG-04): stops the engine and stays in `stopping` until the process exits; later applies do nothing.
	 * Runs on workers are never aborted.
	 */
	stop(): Promise<void>;
	/** Live view of the running engine; undefined unless the phase is `running`. */
	snapshot(): EngineSnapshot | undefined;
}

export interface ControllerOptions {
	/** `<state>` (ASKBOT_STATE_DIR). */
	stateDir: string;
	/** The admin's skills and agents (ASKBOT_OMP_DIR, AGT-24). */
	ompDir: string;
	db: Db;
	vault: Vault;
	agentLog: AgentLog;
	/** Process-wide: outlives every engine instance, so restarts never touch runs (RUN-09). */
	dispatcher: Dispatcher;
	/** Applies Settings → Logs (OBS-04); called on every apply once settings are readable, before the engine starts. */
	applyLogCap?(maxGiB: number): void;
	/** One Discord connection per engine instance; defaults to discord.js. */
	connectDiscord?(): DiscordConnection;
}

/** A running engine instance: everything that must be torn down before settings can be re-applied. */
interface RunningEngine {
	stop(): Promise<void>;
	snapshot(): EngineSnapshot;
}

/** State directories the engine works in (ENG-03 step 1). */
const STATE_DIRS = ["sessions", "scratch", "omp-agent"] as const;

async function startEngine(opts: ControllerOptions, config: Config, secrets: Settings["secrets"]): Promise<RunningEngine> {
	const { stateDir, db, agentLog, dispatcher } = opts;
	for (const dir of STATE_DIRS) await mkdir(join(stateDir, dir), { recursive: true });

	const connection = (opts.connectDiscord ?? createDiscordJsConnection)();
	const lifetime = new AbortController();
	const deps: EngineDeps = { config, db, discord: connection, dispatcher, agentLog, signal: lifetime.signal };
	const askChat = createAskChat(deps, { scratchRoot: join(stateDir, "scratch"), ompDir: opts.ompDir });
	// Attached before login: command registration and the nickname run on every ready event (DSC-01, DSC-29).
	const bot = attachBot({ deps, connection, askChat });
	try {
		await connection.login(secrets.discordToken);
	} catch (err) {
		lifetime.abort();
		bot.detach();
		await connection.destroy().catch(destroyErr => log("warn", "discord destroy failed", { error: errorMessage(destroyErr) }));
		throw new Error(`Discord login failed: ${errorMessage(err)}`);
	}
	// ENG-03 steps 2 and 3: re-attach to the ask threads' runs (RUN-07, RUN-14), then the idle sweep (CHAT-06).
	askChat.start();
	const startedAt = new Date().toISOString();
	log("info", "engine started", { askChannels: config.discord.askChannelIds.length });

	return {
		async stop() {
			// ENG-04 order: the idle sweep and dispatch (detach from runs; never abort them), then Discord.
			lifetime.abort();
			await askChat.detach().catch(err => log("error", "ask chat detach failed", { error: errorMessage(err) }));
			bot.detach();
			await connection.destroy();
			log("info", "engine stopped");
		},
		snapshot() {
			const discord = connection.status();
			return {
				startedAt,
				discord: { ready: discord.ready, user: discord.user, pingMs: discord.pingMs, nicknameWarning: bot.nicknameWarning() },
				discordQueue: connection.queueStats(),
			};
		},
	};
}

/** Owns the engine lifecycle (ENG-01 to ENG-03): started when the vault is unlocked and holds settings, restarted on every save. */
export function createController(opts: ControllerOptions): Controller {
	const { vault, applyLogCap } = opts;
	let running: RunningEngine | undefined;
	// Until the first apply settles: what the vault alone tells.
	const initial: EnginePhase = !vault.isInitialized() ? "setup" : !vault.isUnlocked() ? "locked" : "starting";
	let current: EngineStatus = { phase: initial, since: new Date().toISOString() };
	/** Set by `stop()`: the orchestrator is shutting down and no engine starts again. */
	let closed = false;
	/** Serialises apply/stop so overlapping admin saves cannot start two engines. */
	let queue: Promise<unknown> = Promise.resolve();

	function set(phase: EnginePhase, error?: string): void {
		current = { phase, error, since: new Date().toISOString() };
		if (error) log(phase === "error" ? "error" : "info", "engine status", { phase, error });
		else log("info", "engine status", { phase });
	}

	async function stopRunning(): Promise<void> {
		if (!running) return;
		set("stopping");
		const engine = running;
		running = undefined;
		await engine.stop().catch(err => log("error", "engine stop failed", { error: errorMessage(err) }));
	}

	async function apply(): Promise<void> {
		if (closed) return;
		await stopRunning();
		if (!vault.isInitialized()) return set("setup");
		if (!vault.isUnlocked()) return set("locked");
		let settings: Settings | undefined;
		try {
			settings = vault.readSettings();
		} catch (err) {
			return set("error", errorMessage(err));
		}
		if (!settings) return set("unconfigured");
		// Before the engine starts, so a save takes effect even if the engine then fails to start.
		try {
			applyLogCap?.(settings.config.logs.maxGiB);
		} catch (err) {
			log("error", "applying log size failed", { error: errorMessage(err) });
		}
		if (!hasAskChannel(settings.config)) return set("unconfigured", ASK_CHANNEL_MISSING);
		set("starting");
		try {
			running = await startEngine(opts, settings.config, settings.secrets);
			set("running");
		} catch (err) {
			set("error", errorMessage(err));
		}
	}

	async function shutdown(): Promise<void> {
		closed = true;
		set("stopping");
		const engine = running;
		running = undefined;
		await engine?.stop().catch(err => log("error", "engine stop failed", { error: errorMessage(err) }));
	}

	function enqueue(step: () => Promise<void>): Promise<void> {
		const next = queue.then(step, step);
		queue = next.catch(() => {});
		return next;
	}

	return {
		status: () => current,
		apply: () => enqueue(apply),
		stop: () => enqueue(shutdown),
		snapshot: () => (current.phase === "running" ? running?.snapshot() : undefined),
	};
}
