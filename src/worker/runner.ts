import type { Subprocess } from "bun";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { errorMessage, log } from "../shared/log";
import { installedOmpVersion } from "../shared/ompPins";
import { sha256File, unpackRuntime } from "../shared/ompRuntime";
import type { ChildMessage, HostResult, ParentMessage, Reply, StartOptions } from "../shared/protocol";
import type { RunUsage } from "../shared/transcript";
import type { AppIdentity } from "../shared/version";
import { ARTIFACTS, OMP_RUNTIME_HOST_ENTRY, type OmpRuntimeSpec, type OrchestratorControl, type RelayDown, type RunSpec, type WorkerPhase } from "../shared/wire";
import { ArtifactClient } from "./artifacts";
import type { Lease, WorkerConnection } from "./connection";
import { readOomKills } from "./host/oom";
import { AGENT_RUN_ENV, killMarkedProcesses } from "./host/reap";

/**
 * Process side of one run on a worker (architecture §2.3, ported from DevForge `runAgentProcess`): prepares the
 * run-local directories, downloads the skills, the omp runtime copy, the session and the scratch inputs, spawns the
 * agent host as a child process, relays its IPC to the orchestrator and back, enforces the abort and exit timings
 * (AGT-04) and the scratch copy's disk limit (STO-06), uploads the session while the host runs (RUN-18) and the session
 * and outputs before relaying the result (RUN-19), and kills whatever the run left running (AGT-06). The caller deletes
 * the worker and run-local roots (RUN-20).
 */

/** Entry script of the agent host; resolved from this file so it follows the app copy that runs. */
export const HOST_ENTRY = join(import.meta.dir, "host", "host.ts");

export interface RunTiming {
	heartbeatMs: number;
	/** After an abort is delivered, how long the host gets to report a result before its process group is killed (AGT-04). */
	abortKillMs: number;
	/** After the host reports its result, how long it gets to exit on its own (AGT-04). */
	exitGraceMs: number;
	/** Bound on waiting for the IPC channel to drain after the host exited. */
	disconnectWaitMs: number;
	/** Session upload interval while the host runs (RUN-18). */
	sessionUploadMs: number;
	/** How often the scratch copy's size is measured against its limit (STO-06). */
	diskCheckMs: number;
	/** How long the worker waits for the orchestrator to acknowledge the end of the run before it cleans up anyway. */
	endAckTimeoutMs: number;
	retryMinMs: number;
	retryMaxMs: number;
}

export const DEFAULT_TIMING: Readonly<RunTiming> = Object.freeze({
	heartbeatMs: 10_000,
	abortKillMs: 5_000,
	exitGraceMs: 3_000,
	disconnectWaitMs: 1_000,
	sessionUploadMs: 5 * 60_000,
	diskCheckMs: 5_000,
	endAckTimeoutMs: 10 * 60_000,
	retryMinMs: 1_000,
	retryMaxMs: 15_000,
});

/**
 * The run's directories (architecture §5), deleted with their roots at the end of the run (RUN-20). `root` is on
 * container storage (the scratch, session and skills copies); `runLocal` is the run-local tmpfs (credentials and omp's
 * own files).
 */
export interface RunDirs {
	root: string;
	runLocal: string;
	/** The host's `HOME`: omp's install id and logs (spike S2). Run-local. */
	home: string;
	/** The host's `PI_CODING_AGENT_DIR`: the run-private auth store and model cache, mode 0700 (CRED-02). Run-local. */
	auth: string;
	sessions: string;
	/** The downloaded skills and agents (AGT-24). */
	omp: string;
	/** The host's `TMPDIR`. Run-local. */
	tmp: string;
	/** The scratch copy with `inputs/` and `outputs/` (CHAT-07): the file tools' root. */
	scratch: string;
	/**
	 * The session's working directory (AGT-24): empty, outside the scratch copy, so files the agent writes cannot add
	 * project skills or agents (`.omp/`), which omp looks up from the cwd (spikes A1, A2).
	 */
	work: string;
	/** The unpacked omp runtime copy, when the run uses one (UPD-07): hundreds of MB, so on container storage. */
	ompRuntime: string;
}

export async function makeRunDirs(root: string, runLocal: string): Promise<RunDirs> {
	const dirs: RunDirs = {
		root,
		runLocal,
		home: join(runLocal, "home"),
		auth: join(runLocal, "auth"),
		sessions: join(root, "sessions"),
		omp: join(root, "omp"),
		tmp: join(runLocal, "tmp"),
		scratch: join(root, "scratch"),
		work: join(root, "work"),
		ompRuntime: join(root, "omp-runtime"),
	};
	for (const dir of [dirs.home, dirs.auth, dirs.sessions, dirs.omp, dirs.tmp, dirs.work, join(dirs.scratch, "inputs"), join(dirs.scratch, "outputs")])
		await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dirs.auth, 0o700);
	return dirs;
}

/**
 * Variables the agent host inherits from the supervisor (security review F2): locale, time zone, proxies and CA
 * bundles. Nothing else: no `ASKBOT_*` (the worker token file, the orchestrator URL) and no `PI_*`/`OMP_*` overrides.
 */
const HOST_ENV_NAMES: readonly string[] = [
	"PATH",
	"LANG",
	"LANGUAGE",
	"TZ",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
];
/** `LC_*` locale variables, and the test suite's hooks into the fixture host (`TEST_*`). */
const HOST_ENV_PREFIXES: readonly string[] = ["LC_", "TEST_"];

/**
 * The agent host's environment (F2: an allowlist, never the supervisor's whole environment): omp's `HOME`, agent dir
 * and `TMPDIR` run-local (spike S2), the run marker (AGT-06), and `extra` (dry-run's provider keys).
 */
export function hostEnv(dirs: RunDirs, marker: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (HOST_ENV_NAMES.includes(name) || HOST_ENV_PREFIXES.some(prefix => name.startsWith(prefix))) env[name] = value;
	}
	return {
		...env,
		...extra,
		HOME: dirs.home,
		PI_CODING_AGENT_DIR: dirs.auth,
		TMPDIR: dirs.tmp,
		[AGENT_RUN_ENV]: marker,
	};
}

/** Bytes used under `dir` (`du -sk`), 0 when it does not exist (STO-06). */
export async function diskUsage(dir: string): Promise<number> {
	try {
		await stat(dir);
	} catch {
		return 0;
	}
	const proc = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "ignore" });
	const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	const kib = Number.parseInt(out, 10);
	if (exitCode !== 0 && Number.isNaN(kib)) throw new Error(`du -sk ${dir} failed (exit ${exitCode})`);
	return (Number.isNaN(kib) ? 0 : kib) * 1024;
}

export interface OutputFile {
	/** Upload name: the path relative to `outputs/`, with `/` replaced by `_`. */
	name: string;
	path: string;
}

/** Regular files under `dir`, recursively; symlinks and other entries are skipped (CHAT-10). */
export async function listOutputFiles(dir: string): Promise<OutputFile[]> {
	let entries: { name: string; parentPath: string; isFile(): boolean }[];
	try {
		entries = await readdir(dir, { withFileTypes: true, recursive: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return entries
		.filter(entry => entry.isFile())
		.map(entry => {
			const path = join(entry.parentPath, entry.name);
			return { name: relative(dir, path).split(sep).join("_"), path };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** A cancellable sleep: resolves after `ms`, or at once when `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal.aborted) {
		resolve();
		return promise;
	}
	const timer = setTimeout(resolve, ms);
	signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			resolve();
		},
		{ once: true },
	);
	return promise;
}

const ZERO_USAGE: RunUsage = Object.freeze({ costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** What the worker's message routing hands to the run it is serving. */
export interface ActiveRun {
	onControl(msg: OrchestratorControl): void;
	onRelay(msg: RelayDown["msg"]): Promise<void>;
	onScratchInput(name: string): Promise<void>;
	/** Runs the run to its end; never throws. */
	run(): Promise<void>;
	/** SIGTERM (eviction, shutdown): upload the session, then stop the host and return from `run()` without reporting (RUN-18). */
	terminate(): Promise<void>;
}

export interface SupervisorOptions {
	conn: WorkerConnection;
	lease: Lease;
	orchestratorUrl: string;
	/** Worker root on container storage; the caller deletes it after `run()`. */
	root: string;
	/** Run-local root (tmpfs in the image); the caller deletes it after `run()`. May equal `root`. */
	runLocal: string;
	/** The image's omp version. */
	ompVersion: string;
	/** This worker's app identity (architecture §7.1): an omp runtime copy is used only when its identity is this one (UPD-07). */
	identity: AppIdentity;
	/** The image's agent host entry; tests use a fixture host. */
	hostEntry?: string;
	timing?: Partial<RunTiming>;
	/** The scratch copy's size limit (STO-06, `ASKBOT_WORKER_DISK`); undefined measures nothing. */
	diskLimitBytes?: number;
	onPhase(phase: WorkerPhase): void;
}

/** Request id of the worker's own steer telling the agent about the disk limit; negative, so no orchestrator id collides. */
const DISK_STEER_ID = -1;

/** The omp runtime copy a run's host is spawned from (UPD-07). */
interface RuntimeCopy {
	copy: string;
	version: string;
	/** The host entry inside the unpacked copy. */
	entry: string;
}

/** How much of a copy's host stderr is kept for the canary report (UPD-08). */
const STDERR_TAIL_CHARS = 4096;

type HostOutcome = { kind: "result"; msg: Extract<ChildMessage, { t: "done" | "failed" }> } | { kind: "gone"; code: number | null; signal: string | null };

/** One ask run (`assign`): heartbeats with the phase, and the stop on `lease-invalid` or SIGTERM. */
export class RunSupervisor implements ActiveRun {
	readonly #opts: SupervisorOptions;
	readonly #timing: RunTiming;
	readonly #runId: string;
	/** Aborted when the run stops early (lease invalid, SIGTERM) and when it ends: pending downloads and waits end. */
	readonly #stop = new AbortController();
	/** Resolves when the run must stop early. */
	readonly #stopped = Promise.withResolvers<void>();
	#phase: WorkerPhase = "preparing";
	readonly #spec: RunSpec;
	readonly #artifacts: ArtifactClient;
	readonly #marker = crypto.randomUUID();
	#dirs: RunDirs | undefined;
	/** Resolves with true once the run-local directories and downloads are ready, false when they never will be. */
	readonly #prepared = Promise.withResolvers<boolean>();
	/** Resolves with the host process once spawned, or undefined when it never will be. */
	readonly #host = Promise.withResolvers<Subprocess | undefined>();
	#proc: Subprocess | undefined;
	#hostExited = false;
	#outcome: PromiseWithResolvers<HostOutcome> | undefined;
	#terminal: HostOutcome | undefined;
	#killTimer: ReturnType<typeof setTimeout> | undefined;
	#forced = false;
	#lastUsage: RunUsage = ZERO_USAGE;
	#usageReported = false;
	#runEnded = false;
	#sessionFile: string | undefined;
	#upChain: Promise<void> = Promise.resolve();
	/** Session uploads run one at a time (at `session_file`, the timer, SIGTERM and before the result, RUN-18). */
	#sessionChain: Promise<unknown> = Promise.resolve();
	/** Local auth-store row id → orchestrator credential id (CRED-03). */
	#credentialIds = new Map<string, string>();
	#credentialSeq = 0;
	/** `credential-request` id → the host's request id. */
	#credentialRequests = new Map<number, number>();
	/** Set once the scratch copy passed its disk limit: the run fails with this (STO-06). */
	#diskFailure: string | undefined;
	#diskBusy = false;
	/** The omp runtime copy the next host is spawned from; cleared by the one fallback (UPD-07, UPD-08). */
	#copy: RuntimeCopy | undefined;
	/** The current host relayed `registered`. */
	#registered = false;
	/** Tail of the current host's stderr, kept only for a host from a copy (UPD-08). */
	#stderrTail = "";
	#stderrDrained: Promise<void> = Promise.resolve();
	#oomAtSpawn: number | undefined;

	constructor(opts: SupervisorOptions, spec: RunSpec) {
		this.#opts = opts;
		this.#timing = { ...DEFAULT_TIMING, ...opts.timing };
		this.#runId = opts.lease.runId;
		this.#spec = spec;
		this.#artifacts = new ArtifactClient({
			orchestratorUrl: opts.orchestratorUrl,
			runId: opts.lease.runId,
			leaseToken: opts.lease.token,
			signal: this.#stop.signal,
			retryMinMs: this.#timing.retryMinMs,
			retryMaxMs: this.#timing.retryMaxMs,
		});
	}

	onControl(msg: OrchestratorControl): void {
		if (msg.t === "credential-response" && msg.runId === this.#runId) {
			const hostId = this.#credentialRequests.get(msg.requestId);
			if (hostId === undefined) return;
			this.#credentialRequests.delete(msg.requestId);
			this.#reply(hostId, msg.ok ? { ok: true, value: { accessToken: msg.accessToken, expiresAt: msg.expiresAt } } : { ok: false, error: msg.error });
			return;
		}
		if (msg.t === "lease-invalid" && msg.runId === this.#runId) {
			this.#stopNow("lease invalid");
			this.#killGroup();
		}
	}

	async onRelay(msg: RelayDown["msg"]): Promise<void> {
		const proc = await this.#host.promise;
		if (!proc || this.#hostExited) return;
		if (msg.t === "abort" && !this.#terminal) {
			// Backstop for a host that ignores the abort: after this its whole process group is killed (AGT-04).
			this.#killTimer ??= setTimeout(() => {
				this.#forced = true;
				log("warn", "agent host did not stop after abort; killing it", { run: this.#runId });
				this.#killGroup();
			}, this.#timing.abortKillMs);
		}
		this.#send(msg);
	}

	async onScratchInput(name: string): Promise<void> {
		if (!(await this.#prepared.promise)) return;
		await this.#downloadInput(name);
	}

	async terminate(): Promise<void> {
		if (!this.#stop.signal.aborted) await this.#uploadSession();
		this.#stopNow("SIGTERM");
		this.#killGroup();
	}

	async run(): Promise<void> {
		this.#opts.onPhase(this.#phase);
		this.#heartbeat();
		const heartbeat = setInterval(() => this.#heartbeat(), this.#timing.heartbeatMs);
		try {
			await Promise.race([this.#lifecycle(), this.#stopped.promise]);
		} catch (err) {
			if (!this.#stop.signal.aborted) log("error", "run failed on the worker", { run: this.#runId, error: errorMessage(err) });
		} finally {
			clearInterval(heartbeat);
			this.#setPhase("cleanup");
			if (!this.#stop.signal.aborted) this.#stop.abort(new Error("run ended"));
			this.#cleanup();
		}
	}

	#setPhase(phase: WorkerPhase): void {
		// A lifecycle still unwinding after an early stop must not move the phase back from `cleanup`.
		if (this.#phase === "cleanup") return;
		this.#phase = phase;
		this.#opts.onPhase(phase);
	}

	#heartbeat(): void {
		this.#opts.conn.sendIfConnected({ t: "heartbeat", runId: this.#runId, token: this.#opts.lease.token, phase: this.#phase });
	}

	#stopNow(reason: string): void {
		if (this.#stop.signal.aborted) return;
		log("info", "run stopped on the worker", { run: this.#runId, reason });
		this.#stop.abort(new Error(reason));
		this.#stopped.resolve();
	}

	async #lifecycle(): Promise<void> {
		let start: StartOptions;
		try {
			start = await this.#prepare();
		} catch (err) {
			this.#notPrepared();
			if (this.#stop.signal.aborted) throw err;
			log("error", "run preparation failed", { run: this.#runId, error: errorMessage(err) });
			await this.#finish({ t: "failed", name: "Error", message: `The worker could not prepare the run: ${errorMessage(err)}` });
			return;
		}
		this.#setPhase("running");
		const outcome = await this.#runAgent(start);
		if (this.#stop.signal.aborted) return;
		this.#setPhase("uploading");
		await this.#upChain;
		await this.#uploadSession();
		await this.#uploadOutputs();
		if (this.#diskFailure) {
			this.#reportEnd(undefined, this.#diskFailure);
			await this.#finish({ t: "failed", name: "Error", message: this.#diskFailure });
			return;
		}
		if (outcome.kind === "result") {
			await this.#finish(outcome.msg);
			return;
		}
		const oomKills = this.#oomKillsSince();
		if (this.#forced) {
			// Killed after an ignored abort: the run ends as aborted by the user (AGT-04).
			this.#reportEnd("user");
			const result: HostResult = { sessionFile: this.#sessionFile ?? start.resumeFile ?? "", usage: this.#lastUsage, aborted: "user", oomKills };
			await this.#finish({ t: "done", result });
			return;
		}
		const reason = outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code}`;
		const error =
			outcome.signal === "SIGKILL" && oomKills > 0
				? `agent process was killed (${reason}); the kernel OOM killer killed ${oomKills} process(es) in this container meanwhile, so it most likely ran out of memory`
				: `agent process exited with ${reason}`;
		log("warn", "agent host exited without a result", { run: this.#runId, code: outcome.code, signal: outcome.signal, oomKills });
		this.#reportEnd(undefined, error);
		this.#opts.conn.send({ t: "gone", runId: this.#runId, exitCode: outcome.code, signal: outcome.signal, oomKills });
		// The orchestrator answers `gone` with `lease-invalid`.
		await delay(this.#timing.endAckTimeoutMs, this.#stop.signal);
	}

	/**
	 * Sends `run-info` with the omp this host uses and runs it. The first host from an omp runtime copy is its canary
	 * (UPD-08): when it exits before `registered` (and the run was not stopped, aborted or over its disk limit), the copy
	 * is reported failed and the same run starts again with the image's omp, once.
	 */
	async #runAgent(start: StartOptions): Promise<HostOutcome> {
		const copy = this.#copy;
		this.#opts.conn.send({ t: "run-info", runId: this.#runId, ompVersion: copy?.version ?? this.#opts.ompVersion });
		const outcome = await this.#runHost(start, copy?.entry ?? this.#opts.hostEntry ?? HOST_ENTRY, copy !== undefined);
		if (!copy || this.#registered || this.#stop.signal.aborted || this.#killTimer !== undefined || this.#diskFailure) return outcome;
		this.#copy = undefined;
		await Promise.race([this.#stderrDrained, Bun.sleep(this.#timing.disconnectWaitMs)]);
		const exit = outcome.kind === "gone" ? { exitCode: outcome.code, signal: outcome.signal } : { exitCode: null, signal: null };
		const failure = outcome.kind === "result" && outcome.msg.t === "failed" ? `\n${outcome.msg.name}: ${outcome.msg.message}` : "";
		log("warn", "the agent host from the omp runtime copy exited before it registered; falling back to the image's omp", {
			run: this.#runId,
			copy: copy.copy,
			version: copy.version,
			...exit,
		});
		this.#opts.conn.send({ t: "omp-runtime-failed", runId: this.#runId, copy: copy.copy, version: copy.version, ...exit, output: `${this.#stderrTail}${failure}`.slice(-STDERR_TAIL_CHARS) });
		// Whatever the failed host left in its process group goes; the next host starts from a clean slate.
		this.#killGroup();
		this.#proc = undefined;
		this.#hostExited = false;
		this.#outcome = undefined;
		this.#terminal = undefined;
		this.#sessionFile = undefined;
		this.#lastUsage = ZERO_USAGE;
		this.#usageReported = false;
		this.#runEnded = false;
		this.#credentialRequests.clear();
		return this.#runAgent(start);
	}

	/** UPD-07: the spec's omp runtime copy, downloaded, checked and unpacked; undefined when the run uses the image's omp. */
	async #fetchRuntime(dirs: RunDirs, spec: OmpRuntimeSpec): Promise<RuntimeCopy | undefined> {
		const own = this.#opts.identity;
		const fields = { run: this.#runId, copy: spec.copy, version: spec.version };
		if (spec.identity.version !== own.version || spec.identity.hash !== own.hash) {
			log("info", "the omp runtime copy was made for another app identity; using the image's omp", { ...fields, copyIdentity: spec.identity, identity: own });
			return undefined;
		}
		const archive = join(dirs.root, "omp-runtime.tar.gz");
		try {
			if (!(await this.#artifacts.download(ARTIFACTS.ompRuntime, archive))) {
				log("warn", "the omp runtime copy is gone; using the image's omp", fields);
				return undefined;
			}
			const sha256 = await sha256File(archive);
			if (sha256 !== spec.sha256) throw new Error(`the archive's sha256 is ${sha256}, expected ${spec.sha256}`);
			await unpackRuntime(archive, dirs.ompRuntime);
			const version = installedOmpVersion(dirs.ompRuntime);
			if (version !== spec.version) throw new Error(`the copy holds omp ${version}, expected ${spec.version}`);
			log("info", "omp runtime copy unpacked", { ...fields, sizeBytes: spec.size });
			return { copy: spec.copy, version, entry: join(dirs.ompRuntime, OMP_RUNTIME_HOST_ENTRY) };
		} catch (err) {
			if (this.#stop.signal.aborted) throw err;
			log("warn", "the omp runtime copy is unusable; using the image's omp", { ...fields, error: errorMessage(err) });
			await rm(dirs.ompRuntime, { recursive: true, force: true });
			return undefined;
		} finally {
			await rm(archive, { force: true });
		}
	}

	#cleanup(): void {
		this.#notPrepared();
		clearTimeout(this.#killTimer);
		for (const hostId of this.#credentialRequests.values()) this.#reply(hostId, { ok: false, error: "the run ended" });
		this.#credentialRequests.clear();
		// Whatever the run left running dies with it: its process group, then anything that left the group (`setsid`)
		// but kept the run marker in its environment (AGT-06).
		if (this.#proc) this.#killGroup();
		const left = killMarkedProcesses(this.#marker);
		if (left.length > 0) log("info", "agent run left processes; killed", { run: this.#runId, pids: left });
	}

	#notPrepared(): void {
		this.#prepared.resolve(false);
		this.#host.resolve(undefined);
	}

	async #prepare(): Promise<StartOptions> {
		const spec = this.#spec;
		const dirs = await makeRunDirs(this.#opts.root, this.#opts.runLocal);
		this.#dirs = dirs;
		// Dynamic: omp captures `PI_CODING_AGENT_DIR` and `HOME` when it loads, and `runWorker` sets them to run-local paths first.
		const { seedAuthStore } = await import("./auth");
		this.#credentialIds = await seedAuthStore(dirs.auth, spec.credentials);
		const skills = await this.#artifacts.bytes(ARTIFACTS.skills);
		if (skills && skills.byteLength > 0) await new Bun.Archive(skills).extract(dirs.omp);
		if (spec.ompRuntime) this.#copy = await this.#fetchRuntime(dirs, spec.ompRuntime);
		let resumeFile: string | undefined;
		if (spec.resumeSession) {
			const path = join(dirs.sessions, "resume.jsonl");
			if (await this.#artifacts.download(ARTIFACTS.session, path)) resumeFile = path;
			else log("warn", "session to resume not found; starting a new one", { run: this.#runId });
		}
		for (const name of spec.scratch.inputs) await this.#downloadInput(name);
		this.#prepared.resolve(true);
		return {
			runId: this.#runId,
			cwd: dirs.work,
			sessionDir: dirs.sessions,
			...(resumeFile ? { resumeFile } : {}),
			profile: spec.profile,
			...(spec.model ? { modelPattern: spec.model } : {}),
			thinking: spec.thinking,
			prompt: spec.prompt,
			...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
			limits: spec.limits,
			omp: spec.omp,
			wantLoadout: true,
			scratchRoot: dirs.scratch,
		};
	}

	async #downloadInput(name: string): Promise<void> {
		const scratch = this.#dirs?.scratch;
		if (!scratch) return;
		if (basename(name) !== name || name === "." || name === ".." || name === "") {
			log("warn", "scratch input with an unsafe name skipped", { run: this.#runId, name });
			return;
		}
		if (!(await this.#artifacts.download(ARTIFACTS.scratchInput(name), join(scratch, "inputs", name)))) {
			log("warn", "scratch input not found", { run: this.#runId, name });
		}
	}

	#oomKillsSince(): number {
		const now = readOomKills();
		return this.#oomAtSpawn === undefined || now === undefined ? 0 : Math.max(0, now - this.#oomAtSpawn);
	}

	/** Spawns the host from `entry` and runs it to its outcome; `keepStderr` keeps its stderr's tail (a copy's canary, UPD-08). */
	async #runHost(start: StartOptions, entry: string, keepStderr: boolean): Promise<HostOutcome> {
		const dirs = this.#dirs!;
		const outcome = Promise.withResolvers<HostOutcome>();
		this.#outcome = outcome;
		this.#registered = false;
		this.#stderrTail = "";
		const exit = Promise.withResolvers<{ code: number | null; signal: string | null }>();
		const disconnected = Promise.withResolvers<void>();
		this.#oomAtSpawn = readOomKills();
		const proc = Bun.spawn({
			cmd: [process.execPath, entry],
			cwd: dirs.root,
			// omp writes under HOME and PI_CODING_AGENT_DIR; both must be run-local before omp loads (spike S2).
			env: hostEnv(dirs, this.#marker),
			stdin: "ignore",
			stdout: "inherit",
			stderr: keepStderr ? "pipe" : "inherit",
			// JSON, not "advanced": a malformed advanced frame becomes a process-global uncaughtException (oven-sh/bun#37287).
			serialization: "json",
			// Own process group: a forced kill takes the agent's tool subprocesses with it.
			detached: true,
			ipc: message => this.#fromHost(message as ChildMessage),
			onDisconnect: () => disconnected.resolve(),
			onExit: (exited, code) => exit.resolve({ code, signal: exited.signalCode === null ? null : String(exited.signalCode) }),
		});
		this.#proc = proc;
		log("info", "agent host started", { run: this.#runId, pid: proc.pid, entry });
		if (proc.stderr instanceof ReadableStream) this.#stderrDrained = this.#teeStderr(proc.stderr);
		this.#send({ t: "start", runtime: { agentDir: dirs.auth, ompDir: dirs.omp, providerKeys: this.#spec.providerKeys }, opts: start });
		this.#host.resolve(proc);
		const sessionUploads = setInterval(() => void this.#uploadSession(), this.#timing.sessionUploadMs);
		const disk = this.#opts.diskLimitBytes ? setInterval(() => void this.#checkDisk(), this.#timing.diskCheckMs) : undefined;
		// A host that ended without a result: wait for the channel to drain so a result sent just before exit is not lost.
		void exit.promise.then(async ({ code, signal }) => {
			this.#hostExited = true;
			await Promise.race([disconnected.promise, Bun.sleep(this.#timing.disconnectWaitMs)]);
			outcome.resolve({ kind: "gone", code, signal });
		});
		try {
			const result = await outcome.promise;
			clearTimeout(this.#killTimer);
			if (result.kind === "result") {
				const grace = setTimeout(() => this.#killGroup(), this.#timing.exitGraceMs);
				await Promise.race([exit.promise, this.#stopped.promise]);
				clearTimeout(grace);
			}
			return result;
		} finally {
			clearInterval(sessionUploads);
			clearInterval(disk);
		}
	}

	/** Passes the host's stderr through to the worker's and keeps its tail for the canary report (UPD-08). */
	async #teeStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of stream) {
				process.stderr.write(chunk);
				this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
			}
		} catch (err) {
			log("debug", "agent host stderr ended", { run: this.#runId, error: errorMessage(err) });
		}
	}

	/** STO-06: a scratch copy over its limit fails the run; the agent is told first, as after an OOM kill, then the host is stopped. */
	async #checkDisk(): Promise<void> {
		const dir = this.#dirs?.scratch;
		const limit = this.#opts.diskLimitBytes;
		if (!dir || !limit || this.#diskBusy || this.#diskFailure || this.#terminal || this.#hostExited) return;
		this.#diskBusy = true;
		try {
			const used = await diskUsage(dir);
			if (used <= limit || this.#terminal || this.#hostExited) return;
			// MiB below 1 GiB: a small `ASKBOT_WORKER_DISK` would otherwise read "0.0 GiB".
			const size = (bytes: number) => (bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024 ** 3).toFixed(1)} GiB`);
			this.#diskFailure = `the run ran out of disk space: its scratch files used ${size(used)}, over the ${size(limit)} limit`;
			log("warn", "scratch copy over its disk limit; stopping the run", { run: this.#runId, usedBytes: used, limitBytes: limit });
			this.#send({ t: "steer", id: DISK_STEER_ID, text: `The scratch files passed their ${size(limit)} disk limit (${size(used)} used), so this run is being stopped. Do not write more files.` });
			this.#killTimer ??= setTimeout(() => this.#killGroup(), this.#timing.abortKillMs);
		} catch (err) {
			log("warn", "measuring the scratch copy failed", { run: this.#runId, error: errorMessage(err) });
		} finally {
			this.#diskBusy = false;
		}
	}

	#fromHost(msg: ChildMessage): void {
		switch (msg.t) {
			case "credential_request":
				this.#credentialRequest(msg);
				return;
			case "reply":
				// The answer to the worker's own disk-limit steer; the orchestrator never sent it.
				if (msg.id === DISK_STEER_ID) return;
				break;
			case "done":
			case "failed":
				this.#terminal ??= { kind: "result", msg };
				this.#outcome?.resolve(this.#terminal);
				return;
			case "registered":
				this.#registered = true;
				break;
			case "progress":
				this.#lastUsage = msg.usage;
				break;
			case "usage":
				this.#lastUsage = msg.usage;
				this.#usageReported = true;
				break;
			case "transcript":
				if (msg.event.type === "run_end") this.#runEnded = true;
				break;
			case "session_file":
				this.#sessionFile = msg.path;
				// The file is uploaded before the host's report is relayed, so the session the orchestrator records exists (RUN-18).
				this.#up(async () => {
					await this.#uploadSession();
					this.#relay(msg);
				});
				return;
		}
		this.#up(async () => this.#relay(msg));
	}

	#up(task: () => Promise<void>): void {
		this.#upChain = this.#upChain.then(task).catch(err => {
			if (!this.#stop.signal.aborted) log("warn", "relaying a host message failed", { run: this.#runId, error: errorMessage(err) });
		});
	}

	#relay(msg: ChildMessage): void {
		this.#opts.conn.relay(msg);
	}

	/** The host's `run_end` transcript and final usage, when it died before reporting them itself. */
	#reportEnd(aborted: "user" | undefined, error?: string): void {
		if (!this.#usageReported) this.#relay({ t: "usage", usage: this.#lastUsage });
		if (!this.#runEnded) this.#relay({ t: "transcript", event: { type: "run_end", usage: this.#lastUsage, ...(aborted ? { aborted } : {}), ...(error ? { error } : {}) } });
	}

	#credentialRequest(msg: Extract<ChildMessage, { t: "credential_request" }>): void {
		const credentialId = this.#credentialIds.get(msg.credentialId);
		if (credentialId === undefined) {
			// "revoked" makes omp disable the row instead of retrying it (spike S1).
			this.#reply(msg.id, { ok: false, error: `revoked: credential ${msg.credentialId} is not part of this run's sign-ins` });
			return;
		}
		const requestId = ++this.#credentialSeq;
		this.#credentialRequests.set(requestId, msg.id);
		this.#opts.conn.send({
			t: "credential-request",
			runId: this.#runId,
			requestId,
			provider: msg.provider,
			credentialId,
			...(msg.accessToken ? { accessToken: msg.accessToken } : {}),
		});
	}

	#send(msg: ParentMessage): void {
		const proc = this.#proc;
		if (!proc || this.#hostExited) return;
		try {
			proc.send(msg);
		} catch (err) {
			log("warn", "agent host send failed", { run: this.#runId, error: errorMessage(err) });
		}
	}

	#reply(id: number, result: { ok: true; value?: unknown } | { ok: false; error: string }): void {
		this.#send({ t: "reply", id, ...result } as Reply);
	}

	#killGroup(): void {
		const proc = this.#proc;
		if (!proc) return;
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}

	/** Uploads the current session file, one upload at a time, and announces it with `session-upload` (RUN-18). */
	#uploadSession(): Promise<boolean> {
		const next = this.#sessionChain.then(async () => {
			const path = this.#sessionFile;
			if (!path || !(await Bun.file(path).exists())) return false;
			try {
				await this.#artifacts.upload(ARTIFACTS.session, path);
				this.#opts.conn.send({ t: "session-upload", runId: this.#runId });
				return true;
			} catch (err) {
				if (!this.#stop.signal.aborted) log("warn", "session upload failed", { run: this.#runId, error: errorMessage(err) });
				return false;
			}
		});
		this.#sessionChain = next;
		return next;
	}

	/** Ask runs: every regular file in `outputs/` (the copy starts empty, so all are new or changed, RUN-19). */
	async #uploadOutputs(): Promise<void> {
		const scratch = this.#dirs?.scratch;
		if (!scratch) return;
		for (const file of await listOutputFiles(join(scratch, "outputs"))) {
			try {
				await this.#artifacts.upload(ARTIFACTS.scratchOutput(file.name), file.path);
			} catch (err) {
				if (this.#stop.signal.aborted) throw err;
				log("warn", "scratch output upload failed", { run: this.#runId, name: file.name, error: errorMessage(err) });
			}
		}
	}

	/** Relays the result after everything before it, then waits for the orchestrator's ack (RUN-19, RUN-20). */
	async #finish(msg: Extract<ChildMessage, { t: "done" | "failed" }>): Promise<void> {
		await this.#upChain;
		const conn = this.#opts.conn;
		const seq = conn.relay(msg) ?? conn.relay({ t: "failed", name: "Error", message: "The run's result is larger than 4 MiB and could not be reported." });
		if (seq === undefined) return;
		await Promise.race([conn.waitAck(seq), delay(this.#timing.endAckTimeoutMs, this.#stop.signal)]);
	}
}
