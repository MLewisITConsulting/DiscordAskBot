import type { RunStatus, WorkerStatus } from "../../shared/adminApi";
import type { AgentProfile, Loadout } from "../../shared/agent";
import type { RunUsage, TranscriptEvent } from "../../shared/transcript";

/**
 * The engine's view of agent runs (architecture §4). `createWorkerDispatcher` implements it with runs, leases and
 * workers; `createFakeDispatcher` is the test double.
 *
 * Contract:
 * - `runAgent` is **start or attach**: if an unfinished run exists for `req.threadId` (RUN-21: at most one), the call
 *   attaches to it instead of starting another. That is how ask turns survive engine and orchestrator restarts: the
 *   engine re-attaches at start and the dispatcher hands it the live run.
 * - A finished run's result is kept until an attached caller has received it. The dispatcher then forgets it.
 * - Aborting `signal` **detaches**: the promise rejects with `RunDetached` and the run keeps going (ENG-02, RUN-09). It never aborts the run.
 * - `handle.abort(reason)` aborts the run; the result then carries `aborted`.
 */

export interface RunProgress {
	tool?: string;
	intent?: string;
	usage: RunUsage;
	/** Run time so far, excluding worker start and downloads (AGT-14, RUN-03). */
	elapsedMs: number;
}

export interface RunRequest {
	/** The ask thread that owns the run (RUN-21) and where it reports (RUN-14). */
	threadId: string;
	profile: AgentProfile;
	prompt: string;
	/** JSON Schema of the `yield` output (AGT-12). */
	outputSchema?: object;
	/** `models.ask`; undefined = omp default. */
	model?: string;
	thinking: string;
	limits: { minutes: number; costUsd: number };
	/** The omp session this run writes, as a file-name-safe key (`chat-<threadId>`), kept at `<state>/sessions/<key>.jsonl` between runs. */
	session: string;
	/** Continue that session instead of starting it fresh (CHAT-03). */
	resume: boolean;
	/**
	 * The thread's scratch directory in the orchestrator (`<state>/scratch/<threadId>`, CHAT-07). The dispatcher serves
	 * `inputs/` to the worker and writes new or changed outputs it uploads into `outputs/` before the run settles.
	 */
	scratchDir: string;
}

export type AbortReason = "user" | "time" | "cost";

export interface SteerOptions {
	/** Called once if the text can't be delivered right now (worker disconnected, host not `registered`): react ⏳ (RUN-15). */
	onQueued?(): void;
	/** Names (not paths) of new ask attachments saved to `inputs/` that the worker must download before this steer (`scratch-input`, CHAT-08). */
	scratchInputs?: string[];
}

export interface RunHandle {
	/**
	 * AGT-15: delivered as `[Discord @user]: <text>`. Resolves when the run settled it (RUN-15): `delivered` once the host's
	 * reply came back ok (react 👀), `ended` if the run ended first ("Not delivered…"). A host "not ready" refusal is retried
	 * after `registered`, so callers never see it.
	 */
	steer(text: string, from: string, opts?: SteerOptions): Promise<"delivered" | "ended">;
	/** One-shot; the first reason wins (AGT-07). */
	abort(reason: AbortReason): Promise<void>;
}

export interface RunHooks {
	/**
	 * Once per `runAgent` call, as soon as the run can take steering and abort. The worker dispatcher registers at once:
	 * an abort before any worker started the run finishes it immediately (RUN-05), and steers sent before the host is
	 * `registered` are queued (⏳ via `onQueued`) and delivered afterwards (RUN-15). The fake registers per its script.
	 */
	register(handle: RunHandle): void;
	/** While no worker has started the run (RUN-03): "Waiting for a worker…". */
	onWaitingForWorker?(): void;
	onProgress?(p: RunProgress): void;
	onTranscript?(event: TranscriptEvent): void;
	onLoadout?(loadout: Loadout): void;
	/** Once when the run ends, whatever the outcome (OBS-05). */
	onUsage?(usage: RunUsage): void;
}

export interface RunResult {
	output?: unknown;
	usage: RunUsage;
	aborted?: AbortReason;
	/** Processes the kernel OOM-killed during the run (AGT-17 to AGT-19). */
	oomKills: number;
	/** The run's omp session exists in the orchestrator and can be resumed (CHAT-03). */
	hasSession: boolean;
	/** Names of new or changed regular files written to `<scratchDir>/outputs` (CHAT-10). */
	outputs?: string[];
}

/** The caller detached (engine stopping); the run keeps going. */
export class RunDetached extends Error {
	override name = "RunDetached";
	constructor() {
		super("detached from run");
	}
}

/** RUN-04: the worker was lost. The dispatcher never requeues; the turn fails and the user's next message resumes the session. */
export class RunLost extends Error {
	override name = "RunLost";
	constructor() {
		super("the worker running this was lost (pod evicted or crashed)");
	}
}

/** The run ended without a successful `yield` after one nudge (AGT-12). */
export class NoStructuredOutput extends Error {
	override name = "NoStructuredOutput";
	constructor() {
		super("finished without calling yield");
	}
}

export interface Dispatcher {
	runAgent(req: RunRequest, hooks: RunHooks, signal?: AbortSignal): Promise<RunResult>;
	/** True while the thread has a pending or active run (CHAT-04, DSC-06, RUN-21). */
	hasUnfinishedRun(threadId: string): boolean;
	/** True while the thread has a run to attach to: unfinished, or finished with a result no caller has received (NFR-03). */
	hasRun(threadId: string): boolean;
	/** Counts for health and status (architecture §4.5). */
	counts(): { pending: number; running: number; oldestPendingMs: number | null };
	/** Connected workers for the status page; none for the fake. */
	workers(): WorkerStatus[];
	/** Read-only view of the unfinished runs for the status page, oldest first (NFR-06). */
	activeRuns(): RunStatus[];
}

/** RUN-14: the Discord state of a run's live messages, kept per ask thread so a restarted orchestrator edits the same messages. */
export interface RunUiState {
	statusMessage?: { channelId: string; messageId: string };
	/**
	 * Latest progress snapshot (state, activity, elapsed, cost). `startedAtMs` (epoch ms) is when the status message's
	 * clock started; a restarted orchestrator counts elapsed time from it, so the gap since the last edit and the downtime
	 * are not lost. `elapsedMs` is the elapsed time at the last edit.
	 */
	progress?: { state: string; activity: string; elapsedMs: number; costUsd: number; startedAtMs?: number };
}
