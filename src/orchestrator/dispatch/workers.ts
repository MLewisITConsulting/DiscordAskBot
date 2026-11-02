import type { RunStatus, WorkerStatus } from "../../shared/adminApi";
import type { Loadout } from "../../shared/agent";
import { existsSync } from "node:fs";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { Config } from "../../shared/config";
import { addLogSecret, errorMessage, log, removeLogSecret, writeRelayedLogLine } from "../../shared/log";
import type { ChildMessage } from "../../shared/protocol";
import type { RunUsage } from "../../shared/transcript";
import {
	type DownMessage,
	LEASE_MS,
	MAX_WS_MESSAGE_BYTES,
	type RelayDown,
	type RunSpec,
	type UpMessage,
	type WorkerControl,
	type WorkerPhase,
} from "../../shared/wire";
import type { OmpRuntimeSource } from "../omp/updates";
import { type ClaimedRun, type Db, parseJson, type RunOutcome, type RunRow } from "../store/db";
import { sessionDir, sessionPath } from "../store/sessions";
import type { CredentialAnswer, CredentialRequest } from "../store/signins";
import { changedOutputs, createArtifactHandler, STATE_FREE_FLOOR_BYTES } from "./artifacts";
import {
	type AbortReason,
	type Dispatcher,
	NoStructuredOutput,
	RunDetached,
	type RunHandle,
	type RunHooks,
	RunLost,
	type RunRequest,
	type RunResult,
	type SteerOptions,
} from "./dispatcher";
import { claimNextRun, holdsLease } from "./leases";
import { type RunRelay, runRelay } from "./relay";
import { buildRunSpec, type SpecSources, unrunnableReason } from "./spec";

/**
 * The real `Dispatcher` (architecture §4.1 to §4.5): runs live in the `runs` table, each on its own worker. Workers
 * connect over the `/internal/worker` WebSocket, claim one run each, and relay the agent host's IPC; bulk data goes over
 * the run artifact endpoints. Process-wide: engine restarts only detach from runs, and an orchestrator restart re-attaches
 * to the workers that re-announce their leases (RUN-07, RUN-09).
 */

/** RUN-01 caps; `maxConcurrentRuns` already defaults to the worker capacity. */
export interface DispatchLimits {
	maxChatSessions: number;
	maxConcurrentRuns: number;
}

/** The caps for the saved settings' `config`; undefined (settings unsaved, invalid or locked): no run can start. */
export function dispatchLimits(config: Pick<Config, "limits" | "workers"> | undefined, workerCapacity: number): DispatchLimits | undefined {
	if (!config) return undefined;
	return { maxChatSessions: config.limits.maxChatSessions, maxConcurrentRuns: config.workers.maxConcurrentRuns ?? workerCapacity };
}

export interface WorkerDispatcherOptions {
	db: Db;
	stateDir: string;
	/** RUN-01 caps, read whenever a slot may have opened (`dispatchLimits`); undefined: nothing new becomes pending. */
	limits(): DispatchLimits | undefined;
	/** `workers.reattachGraceSeconds` in ms, applied once at start to runs left `assigned` or `running` (RUN-07). */
	reattachGraceMs: number;
	/** Where the run spec's parts come from (read at claim time). */
	spec: SpecSources;
	/** The skills and agents bundle served to workers (AGT-24). */
	skills(): Promise<{ hash: string; tar: Uint8Array }>;
	/** Answers a worker's `credential-request` (CRED-03); must not throw. */
	credentialRequest(req: CredentialRequest): Promise<CredentialAnswer>;
	/** How long a `claim` waits for a pending run before `nothing`; default 10 s. */
	claimWaitMs?: number;
	/** Lease length (default `LEASE_MS`) and how often expired leases are swept (default 1 s); shorter in tests. */
	leaseMs?: number;
	sweepMs?: number;
	/** In-place omp updates (UPD-07, UPD-08): the copy runs are given, its archive, canary failures; none outside the image. */
	ompRuntime?: OmpRuntimeSource;
	/**
	 * Architecture §6, `ASKBOT_WORKER_ADDRESS_BINDING`: a worker id stays bound to the network address it first said
	 * hello from, and an address holds one claim at a time (none for 60 s after its last one ended). Off only where
	 * workers share a source address (a service mesh, or local worker processes in tests).
	 */
	bindWorkerAddresses: boolean;
	/** Free space the state volume keeps: uploads that would go below it are refused; default `STATE_FREE_FLOOR_BYTES`. */
	stateFreeFloorBytes?: number;
}

/** `ws.data` of a worker WebSocket; `server.ts` creates it with `socketData` when it upgrades (after the worker-token check). */
export interface WorkerSocketData {
	address: string;
}

export interface WorkerDispatcher extends Dispatcher {
	/** `GET /internal/scale` (architecture §4.4): runs a new worker could claim. */
	pendingRuns(): number;
	socketData(address: string): WorkerSocketData;
	/** The `/internal/worker` WebSocket handlers. */
	readonly websocket: WebSocketHandler<WorkerSocketData>;
	/** `/internal/runs/<id>/…`, lease-token authorised. */
	artifact(req: Request): Promise<Response>;
	/** Stops timers (RUN-09: never aborts runs). */
	close(): void;
}

/** omp refreshes within 10 s; the answer must arrive before that (CRED-03). */
const CREDENTIAL_ANSWER_MS = 9_500;
const ACTIVE_STATES = ["pending", "assigned", "running", "finishing", "lost"] as const;
/** Architecture §6: how long an address can't claim after a claim from it ended (its worker may still be exiting). */
const ADDRESS_QUIET_MS = 60_000;

type StoredOutcome = { ok: true; result: RunResult } | { ok: false; error: { name: string; message: string }; usage: RunUsage };

interface Caller {
	hooks: RunHooks;
	resolve(result: RunResult): void;
	reject(error: Error): void;
	cleanup(): void;
}

interface Steer {
	text: string;
	opts: SteerOptions | undefined;
	resolve(result: "delivered" | "ended"): void;
	queuedReported: boolean;
}

interface Conn {
	ws: ServerWebSocket<WorkerSocketData>;
	address: string;
	connectedAt: string;
	workerId?: string;
	version?: string;
	ompVersion?: string;
	runOmpVersion?: string;
	/** The run this connection holds the lease of. */
	runId?: string;
	phase?: WorkerPhase;
	claimTimer?: ReturnType<typeof setTimeout>;
	/** Messages are handled one at a time, in order. */
	queue: Promise<void>;
	/** False once the socket closed: nothing more is sent. */
	open: boolean;
	/** Close handled: unbound from its run and claims. */
	closed: boolean;
}

interface Run {
	threadId: string;
	/** Set once the run is admitted (a `runs` row exists). */
	id: string | undefined;
	/** Unknown for a run found in the database after a restart until a caller attaches. */
	req: RunRequest | undefined;
	caller: Caller | undefined;
	handle: RunHandle;
	registered: boolean;
	conn: Conn | undefined;
	usage: RunUsage;
	/** Tool of the latest progress report and the reported loadout, for the status page (NFR-06); lost on restart. */
	lastTool: string | undefined;
	loadout: Loadout | undefined;
	aborted: AbortReason | undefined;
	/** Steers waiting for `registered`. */
	queued: Steer[];
	/** Steers sent, by request id, waiting for the host's reply. */
	sent: Map<number, Steer>;
	/** `scratch-input` names to send before the relay message with this sequence number (CHAT-08). */
	scratchBefore: Map<number, string[]>;
	outcome: StoredOutcome | undefined;
}

const ZERO_USAGE: RunUsage = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function toError(error: { name: string; message: string }): Error {
	if (error.name === "RunLost") return new RunLost();
	if (error.name === "NoStructuredOutput") return new NoStructuredOutput();
	return new Error(error.message);
}

function guard(what: string, fn: () => void, fields: Record<string, unknown> = {}): void {
	try {
		fn();
	} catch (err) {
		log("warn", `${what} failed`, { ...fields, error: errorMessage(err) });
	}
}

/** The outer type and run id of an oversized message, read from its start without parsing it (RUN-16 logging). */
function sniff(text: string): { type?: string; run?: string } {
	const head = text.slice(0, 4096);
	const inner = /"msg"\s*:\s*\{\s*"t"\s*:\s*"([^"]{1,40})"/.exec(head)?.[1];
	const outer = /"t"\s*:\s*"([^"]{1,40})"/.exec(head)?.[1];
	return { type: inner ? `${outer}/${inner}` : outer, run: /"runId"\s*:\s*"([^"]{1,100})"/.exec(head)?.[1] };
}

export function createWorkerDispatcher(opts: WorkerDispatcherOptions): WorkerDispatcher {
	const { db } = opts;
	const leaseMs = opts.leaseMs ?? LEASE_MS;
	const claimWaitMs = opts.claimWaitMs ?? 10_000;
	/** Runs by ask thread: waiting for a slot, active, or finished and not yet delivered. */
	const runs = new Map<string, Run>();
	const byId = new Map<string, Run>();
	/** Runs above their caps, oldest first (RUN-01): in memory only, not `pending`. */
	const waiting: Run[] = [];
	const conns = new Map<WorkerSocketData, Conn>();
	const claimers: Conn[] = [];
	const relays = new Map<string, RunRelay>();
	/** When a connection holding a run last closed, by address (architecture §6 quiet period). */
	const released = new Map<string, number>();
	/** Live lease tokens by run id: masked in every log line while they open anything (F9). */
	const liveLeases = new Map<string, string>();
	const leaseLive = (id: string, token: string): void => {
		liveLeases.set(id, token);
		addLogSecret(token);
	};
	const leaseEnded = (id: string): void => {
		removeLogSecret(liveLeases.get(id));
		liveLeases.delete(id);
	};
	const artifacts = createArtifactHandler({
		db,
		stateDir: opts.stateDir,
		skills: opts.skills,
		ompRuntime: opts.ompRuntime,
		freeFloorBytes: opts.stateFreeFloorBytes ?? STATE_FREE_FLOOR_BYTES,
	});

	const relayOf = (id: string): RunRelay => {
		let relay = relays.get(id);
		if (!relay) {
			relay = runRelay(db, id);
			relays.set(id, relay);
		}
		return relay;
	};

	function send(conn: Conn | undefined, msg: DownMessage): void {
		if (!conn?.open) return;
		try {
			conn.ws.send(JSON.stringify(msg));
		} catch (err) {
			log("warn", "worker send failed", { worker: conn.workerId, error: errorMessage(err) });
		}
	}

	function sessionExists(run: Run): boolean {
		const key = run.req?.session ?? (run.id ? db.getRun(run.id)?.session_key : undefined);
		if (!key) return false;
		try {
			return existsSync(sessionPath(sessionDir(opts.stateDir), key));
		} catch {
			return false;
		}
	}

	// ── Runs in memory ──────────────────────────────────────────────────────────────────────────

	function newRun(threadId: string, req: RunRequest | undefined): Run {
		const run: Run = {
			threadId,
			id: undefined,
			req,
			caller: undefined,
			registered: false,
			conn: undefined,
			usage: ZERO_USAGE,
			lastTool: undefined,
			loadout: undefined,
			aborted: undefined,
			queued: [],
			sent: new Map(),
			scratchBefore: new Map(),
			outcome: undefined,
			handle: {
				steer: (text, from, steerOpts) => steer(run, `[Discord @${from}]: ${text}`, steerOpts),
				abort: async reason => abort(run, reason),
			},
		};
		return run;
	}

	/** The in-memory run of a `runs` row, created from the row after a restart. */
	function ensureRun(row: RunRow): Run {
		const known = byId.get(row.id);
		if (known) return known;
		const run = newRun(row.thread_id, undefined);
		run.id = row.id;
		run.registered = row.state === "running";
		if (row.state === "finished" && row.result) run.outcome = JSON.parse(row.result) as StoredOutcome;
		runs.set(run.threadId, run);
		byId.set(row.id, run);
		return run;
	}

	function forget(run: Run): void {
		if (runs.get(run.threadId) === run) runs.delete(run.threadId);
		if (run.id) {
			byId.delete(run.id);
			relays.delete(run.id);
		}
	}

	function rowState(run: Run): RunRow["state"] | undefined {
		return run.id ? db.getRun(run.id)?.state : undefined;
	}

	// ── Outcomes ───────────────────────────────────────────────────────────────────────────────

	function abortedOutcome(run: Run, reason: AbortReason): StoredOutcome {
		return { ok: true, result: { usage: run.usage, aborted: reason, oomKills: 0, hasSession: sessionExists(run) } };
	}

	function errorOutcome(run: Run, err: unknown): StoredOutcome {
		const error = err instanceof Error ? err : new Error(String(err));
		return { ok: false, error: { name: error.name, message: error.message }, usage: run.usage };
	}

	/** Hands the outcome to the attached caller (usage first, once, OBS-05), then forgets the run. */
	function deliver(run: Run): void {
		const caller = run.caller;
		const outcome = run.outcome;
		if (!caller || !outcome) return;
		run.caller = undefined;
		caller.cleanup();
		guard("usage sink", () => caller.hooks.onUsage?.(outcome.ok ? outcome.result.usage : outcome.usage), { run: run.id });
		if (run.id) db.updateRun(run.id, { result: null });
		forget(run);
		if (outcome.ok) caller.resolve(outcome.result);
		else caller.reject(toError(outcome.error));
	}

	/** Ends the run: stores the outcome until a caller receives it, settles everything still waiting, frees its slot. */
	function finishRun(run: Run, outcome: StoredOutcome, dbOutcome: RunOutcome): void {
		if (run.outcome) return;
		run.outcome = outcome;
		const id = run.id;
		if (id) {
			db.raw.transaction(() => {
				db.transitionRun(id, [...ACTIVE_STATES], "finished", {
					outcome: dbOutcome,
					error: outcome.ok ? null : outcome.error.message,
					result: JSON.stringify(outcome),
				});
				relayOf(id).clear();
			})();
			artifacts.release(id);
			leaseEnded(id);
		}
		const index = waiting.indexOf(run);
		if (index >= 0) waiting.splice(index, 1);
		for (const s of [...run.queued, ...run.sent.values()]) s.resolve("ended");
		run.queued = [];
		run.sent.clear();
		log("info", "run finished", { run: id, thread: run.threadId, outcome: dbOutcome });
		deliver(run);
		admit();
	}

	/** A `runs` row nobody can continue (no request known): finished without a result, so the thread's next turn starts afresh. */
	function dropOrphan(row: RunRow): void {
		db.transitionRun(row.id, ["pending"], "finished", { outcome: "cancelled" });
		relayOf(row.id).clear();
		const run = byId.get(row.id);
		if (run) forget(run);
		log("info", "orphaned pending run dropped", { run: row.id });
	}

	// ── Admission and claims (RUN-01, RUN-02) ─────────────────────────────────────────────────

	/** Runs that hold a slot: pending or active (RUN-01). */
	function activeCount(): number {
		return db.runsInState(...ACTIVE_STATES).length;
	}

	/** The run becomes claimable: its `runs` row is inserted as `pending`; a resumed turn continues the thread's previous run (DB-02). */
	function insertPending(entry: Run): void {
		const req = entry.req!;
		try {
			const continuesRunId = req.resume ? db.latestRun(req.threadId)?.id : undefined;
			const row = db.insertRun({
				threadId: req.threadId,
				continuesRunId,
				sessionKey: req.session,
				scratchDir: req.scratchDir,
				request: JSON.stringify(req),
			});
			entry.id = row.id;
			byId.set(row.id, entry);
			log("info", "run pending", { run: row.id, thread: req.threadId, continues: continuesRunId });
		} catch (err) {
			finishRun(entry, errorOutcome(entry, err), "failed");
		}
	}

	/** Moves waiting runs to `pending` as far as the caps allow, oldest first (RUN-01). */
	function admit(): void {
		const limits = opts.limits();
		if (limits && waiting.length > 0) {
			let active = activeCount();
			const cap = Math.min(limits.maxChatSessions, limits.maxConcurrentRuns);
			while (waiting.length > 0 && active < cap) {
				insertPending(waiting.shift()!);
				active++;
			}
		}
		match();
	}

	/** Hands pending runs to waiting claims, oldest first. */
	function match(): void {
		while (claimers.length > 0) {
			let row: RunRow | undefined;
			for (const pending of db.runsInState("pending")) {
				if (byId.get(pending.id)?.req) {
					row = pending;
					break;
				}
				dropOrphan(pending);
			}
			if (!row) return;
			const conn = claimers.shift()!;
			clearTimeout(conn.claimTimer);
			if (!conn.open || !conn.workerId) continue;
			if (addressBusy(conn)) {
				send(conn, { t: "nothing" });
				continue;
			}
			const claimed = claimNextRun(db, conn.workerId, leaseMs, conn.address);
			if (!claimed) {
				send(conn, { t: "nothing" });
				continue;
			}
			void assignRun(conn, claimed);
		}
	}

	/**
	 * Architecture §6: another connection from `conn`'s address holds a run, or one claimed from it ended
	 * less than `ADDRESS_QUIET_MS` ago. The runs table keeps the address, so this holds across a restart.
	 */
	function addressBusy(conn: Conn): boolean {
		if (!opts.bindWorkerAddresses) return false;
		for (const other of conns.values()) if (other !== conn && other.address === conn.address && other.runId) return true;
		const since = Date.now() - ADDRESS_QUIET_MS;
		if ((released.get(conn.address) ?? 0) > since) return true;
		return db.addressHoldsRun(conn.address, new Date(since));
	}

	function bind(conn: Conn, run: Run): void {
		if (run.conn && run.conn !== conn) run.conn.runId = undefined;
		run.conn = conn;
		conn.runId = run.id;
	}

	async function assignRun(conn: Conn, row: ClaimedRun): Promise<void> {
		const run = byId.get(row.id)!;
		bind(conn, run);
		log("info", "run claimed", { run: row.id, worker: conn.workerId });
		let spec: RunSpec;
		try {
			spec = await buildRunSpec(row, run.req!, opts.spec, opts.ompRuntime?.forRun(row.id));
		} catch (err) {
			log("error", "run spec failed", { run: row.id, error: errorMessage(err) });
			const holder = run.conn;
			finishRun(run, errorOutcome(run, err), "failed");
			send(holder, { t: "lease-invalid", runId: row.id });
			return;
		}
		const now = db.getRun(row.id);
		if (run.outcome || now?.lease_token !== row.lease_token || now?.state !== "assigned") return;
		leaseLive(row.id, row.leaseToken);
		send(run.conn, { t: "assign", runId: row.id, token: row.leaseToken, kind: "run", spec });
	}

	// ── Leases (RUN-02, RUN-04, RUN-07) ────────────────────────────────────────────────────────

	function sweep(): void {
		const { requeued, lost } = db.expireLeases();
		for (const row of requeued) {
			leaseEnded(row.id);
			const run = byId.get(row.id);
			if (run?.conn) {
				run.conn.runId = undefined;
				run.conn = undefined;
			}
			if (run?.aborted) finishRun(run, abortedOutcome(run, run.aborted), "aborted");
			else if (!run?.req) dropOrphan(row);
			else {
				// Pending again: the next claim builds a fresh spec.
				log("warn", "run lease expired before it started; pending again", { run: row.id });
				guard("waiting sink", () => run.caller?.hooks.onWaitingForWorker?.(), { run: row.id });
			}
		}
		for (const row of lost) {
			const run = ensureRun(row);
			run.conn = undefined;
			log("warn", "worker lost", { run: row.id, worker: row.worker_id, losses: row.loss_count });
			if (run.aborted) finishRun(run, abortedOutcome(run, run.aborted), "aborted");
			else finishRun(run, { ok: false, error: { name: "RunLost", message: new RunLost().message }, usage: run.usage }, "lost");
		}
		const now = Date.now();
		for (const [address, at] of released) if (at <= now - ADDRESS_QUIET_MS) released.delete(address);
		if (requeued.length > 0 || waiting.length > 0) admit();
	}

	// ── Steering and abort (RUN-05, RUN-15) ──────────────────────────────────

	function reportQueued(s: Steer): void {
		if (s.queuedReported) return;
		s.queuedReported = true;
		guard("steer queued sink", () => s.opts?.onQueued?.());
	}

	function sendRelay(run: Run, build: (seq: number) => RelayDown["msg"]): RelayDown {
		const envelope = relayOf(run.id!).enqueue(build);
		send(run.conn, envelope);
		return envelope;
	}

	function sendSteer(run: Run, s: Steer): void {
		const inputs = s.opts?.scratchInputs ?? [];
		const envelope = relayOf(run.id!).enqueue(id => ({ t: "steer", id, text: s.text }));
		run.sent.set(envelope.seq, s);
		if (inputs.length > 0) run.scratchBefore.set(envelope.seq, inputs);
		if (!run.conn?.open) {
			reportQueued(s);
			return;
		}
		for (const name of inputs) send(run.conn, { t: "scratch-input", runId: run.id!, name });
		send(run.conn, envelope);
	}

	function steer(run: Run, text: string, steerOpts: SteerOptions | undefined): Promise<"delivered" | "ended"> {
		if (run.outcome) return Promise.resolve("ended");
		const { promise, resolve } = Promise.withResolvers<"delivered" | "ended">();
		const s: Steer = { text, opts: steerOpts, resolve, queuedReported: false };
		if (run.registered && run.id) sendSteer(run, s);
		else {
			reportQueued(s);
			run.queued.push(s);
		}
		return promise;
	}

	function abort(run: Run, reason: AbortReason): void {
		if (run.outcome || run.aborted) return;
		run.aborted = reason;
		const state = rowState(run);
		log("info", "run abort requested", { run: run.id, thread: run.threadId, reason, state });
		if (state === "assigned" && !run.conn?.open) {
			// RUN-05: its worker is away and may have started the run meanwhile: finished when it re-announces, or at lease expiry.
			return;
		}
		if (!run.id || state === "pending" || state === "assigned") {
			// Nothing ran yet: finish now; the worker holding the lease is told to stop.
			const holder = run.conn;
			finishRun(run, abortedOutcome(run, reason), "aborted");
			if (run.id) send(holder, { t: "lease-invalid", runId: run.id });
			return;
		}
		// Running: delivered now or after the reconnect (stored in the outbox); a lease expiry finishes it instead.
		sendRelay(run, id => ({ t: "abort", id, reason }));
	}

	// ── Relay from the agent host (architecture §4.2) ────────────────────────────────────────

	async function onRelay(run: Run, msg: ChildMessage): Promise<void> {
		const hooks = run.caller?.hooks;
		const fields = { run: run.id };
		switch (msg.t) {
			case "progress":
				run.usage = msg.usage;
				if (msg.tool) run.lastTool = msg.tool;
				guard("progress sink", () => hooks?.onProgress?.({ tool: msg.tool, intent: msg.intent, usage: msg.usage, elapsedMs: msg.elapsedMs }), fields);
				return;
			case "transcript":
				guard("transcript sink", () => hooks?.onTranscript?.(msg.event), fields);
				return;
			case "loadout":
				run.loadout = msg.loadout;
				guard("loadout sink", () => hooks?.onLoadout?.(msg.loadout), fields);
				return;
			case "usage":
				run.usage = msg.usage;
				return;
			case "log":
				// F9: one JSON object per line, attributed here; anything else could forge entries and is dropped.
				if (!writeRelayedLogLine(msg.line, { component: "agent-host", ...(run.id ? { run: run.id } : {}) })) {
					log("warn", "relayed agent host log line dropped: not one JSON object on one line", { run: run.id, bytes: msg.line.length });
				}
				return;
			case "session_file":
				// The worker uploaded the session before relaying this (RUN-18); the host waits for this reply.
				sendRelay(run, () => ({ t: "reply", id: msg.id, ok: true }));
				return;
			case "registered":
				if (run.id) db.transitionRun(run.id, ["assigned"], "running");
				run.registered = true;
				log("info", "run started", fields);
				for (const s of run.queued.splice(0)) sendSteer(run, s);
				return;
			case "reply": {
				const s = run.sent.get(msg.id);
				if (!s) return;
				run.sent.delete(msg.id);
				if (msg.ok) s.resolve("delivered");
				else if (/not ready/i.test(msg.error)) {
					// RUN-15: resent after the next `registered`.
					reportQueued(s);
					run.queued.push(s);
				} else s.resolve("ended");
				return;
			}
			case "done": {
				const r = msg.result;
				const row = db.getRun(run.id!);
				// RUN-19: the worker uploaded the session and the outputs before relaying this.
				const outputs = row?.scratch_dir ? await changedOutputs(row) : undefined;
				const result: RunResult = {
					output: r.output,
					usage: r.usage,
					...(r.aborted ? { aborted: r.aborted } : {}),
					oomKills: r.oomKills,
					hasSession: sessionExists(run),
					...(outputs ? { outputs } : {}),
				};
				run.usage = r.usage;
				finishRun(run, { ok: true, result }, r.aborted ? "aborted" : "succeeded");
				return;
			}
			case "failed":
				finishRun(run, { ok: false, error: { name: msg.name, message: msg.message }, usage: run.usage }, "failed");
				return;
			case "credential_request":
				// Handled by the worker supervisor as `credential-request`; never relayed.
				return;
		}
	}

	// ── Worker connections ──────────────────────────────────────────────────────────────────

	/** The run `conn` holds the lease of, if `runId` is it. */
	function heldRun(conn: Conn, runId: string): Run | undefined {
		const run = byId.get(runId);
		return run && run.conn === conn && conn.runId === runId ? run : undefined;
	}

	function resend(run: Run): void {
		for (const envelope of relayOf(run.id!).unacked()) {
			for (const name of run.scratchBefore.get(envelope.seq) ?? []) send(run.conn, { t: "scratch-input", runId: run.id!, name });
			send(run.conn, envelope);
		}
	}

	function onHello(conn: Conn, msg: Extract<WorkerControl, { t: "hello" }>): void {
		if (conn.workerId) return;
		if (opts.bindWorkerAddresses) {
			const bound = db.bindWorkerAddress(msg.workerId, conn.address);
			if (bound !== conn.address) {
				// Architecture §6: a worker id belongs to the address it first came from; nobody else may take it over.
				log("warn", "worker id used from another address; refused", { worker: msg.workerId, address: conn.address, bound });
				conn.ws.close(1008, "worker id bound to another address");
				return;
			}
		}
		for (const other of conns.values()) {
			if (other !== conn && other.workerId === msg.workerId) {
				log("warn", "worker reconnected; closing its previous connection", { worker: msg.workerId });
				other.ws.close(1000, "replaced by a newer connection");
				onClose(other);
			}
		}
		conn.workerId = msg.workerId;
		conn.version = msg.identity.version;
		conn.ompVersion = msg.ompVersion;
		log("info", "worker connected", { worker: msg.workerId, address: conn.address, version: msg.identity.version, lease: msg.lease?.runId });
		if (!msg.lease) return;
		const { runId, token } = msg.lease;
		const row = db.getRun(runId);
		if (!holdsLease(row, msg.workerId, token) || !db.renewLease(runId, token, leaseMs)) {
			log("info", "stale lease refused", { worker: msg.workerId, run: runId });
			send(conn, { t: "lease-invalid", runId });
			return;
		}
		const run = ensureRun(row);
		bind(conn, run);
		leaseLive(runId, token);
		log("info", "worker re-attached", { worker: msg.workerId, run: runId });
		if (run.aborted && rowState(run) === "assigned") {
			// RUN-05: an abort requested while its worker was away.
			finishRun(run, abortedOutcome(run, run.aborted), "aborted");
			send(conn, { t: "lease-invalid", runId });
			return;
		}
		resend(run);
		if (run.registered) for (const s of run.queued.splice(0)) sendSteer(run, s);
	}

	function onClaim(conn: Conn): void {
		const workerId = conn.workerId!;
		const previous = db.workerClaim(workerId);
		if (previous !== null) {
			// One claim per worker id, ever (architecture §6); an assignment lost in a reconnect goes back to pending at lease expiry (RUN-02).
			log("warn", "second claim refused", { worker: workerId, claimed: previous });
			send(conn, { t: "nothing" });
			return;
		}
		if (addressBusy(conn)) {
			log("warn", "claim refused: this address already holds a claim", { worker: workerId, address: conn.address });
			send(conn, { t: "nothing" });
			return;
		}
		if (claimers.includes(conn)) return;
		claimers.push(conn);
		conn.claimTimer = setTimeout(() => {
			const index = claimers.indexOf(conn);
			if (index < 0) return;
			claimers.splice(index, 1);
			send(conn, { t: "nothing" });
		}, claimWaitMs);
		match();
	}

	async function answerCredential(conn: Conn, msg: Extract<WorkerControl, { t: "credential-request" }>): Promise<void> {
		const timeout = Promise.withResolvers<CredentialAnswer>();
		const timer = setTimeout(() => timeout.resolve({ ok: false, error: "the orchestrator could not refresh the sign-in in time" }), CREDENTIAL_ANSWER_MS);
		let answer: CredentialAnswer;
		try {
			answer = await Promise.race([
				opts.credentialRequest({ provider: msg.provider, credentialId: msg.credentialId, accessToken: msg.accessToken }),
				timeout.promise,
			]);
		} catch (err) {
			answer = { ok: false, error: errorMessage(err) };
		} finally {
			clearTimeout(timer);
		}
		send(conn, { t: "credential-response", runId: msg.runId, requestId: msg.requestId, ...answer });
	}

	async function onMessage(conn: Conn, msg: UpMessage): Promise<void> {
		if (msg.t === "hello") return onHello(conn, msg);
		if (!conn.workerId) {
			log("warn", "worker message before hello; closing", { address: conn.address, type: msg.t });
			conn.ws.close(1008, "hello first");
			return;
		}
		switch (msg.t) {
			case "claim":
				return onClaim(conn);
			case "heartbeat": {
				conn.phase = msg.phase;
				if (!holdsLease(db.getRun(msg.runId), conn.workerId, msg.token) || !db.renewLease(msg.runId, msg.token, leaseMs)) {
					send(conn, { t: "lease-invalid", runId: msg.runId });
				}
				return;
			}
			case "relay": {
				const run = heldRun(conn, msg.runId);
				if (!run) {
					send(conn, { t: "lease-invalid", runId: msg.runId });
					return;
				}
				const relay = relayOf(msg.runId);
				if (relay.accept(msg.seq)) {
					try {
						await onRelay(run, msg.msg);
					} catch (err) {
						log("error", "relay message failed", { run: msg.runId, type: msg.msg.t, error: errorMessage(err) });
					}
				}
				send(conn, { t: "ack", runId: msg.runId, seq: relay.received() });
				return;
			}
			case "ack": {
				const run = heldRun(conn, msg.runId);
				if (!run) return;
				relayOf(msg.runId).ack(msg.seq);
				for (const seq of run.scratchBefore.keys()) if (seq <= msg.seq) run.scratchBefore.delete(seq);
				return;
			}
			case "run-info": {
				if (!heldRun(conn, msg.runId)) return;
				conn.runOmpVersion = msg.ompVersion;
				db.updateRun(msg.runId, { omp_version: msg.ompVersion });
				return;
			}
			case "omp-runtime-failed": {
				if (!heldRun(conn, msg.runId)) return;
				const { t: _t, ...report } = msg;
				guard("omp runtime canary report", () => opts.ompRuntime?.canaryFailed(report), { run: msg.runId, copy: msg.copy });
				return;
			}
			case "session-upload":
				log("debug", "session uploaded", { run: msg.runId });
				return;
			case "gone": {
				const run = heldRun(conn, msg.runId);
				if (!run) {
					send(conn, { t: "lease-invalid", runId: msg.runId });
					return;
				}
				const reason = msg.signal ? `signal ${msg.signal}` : `code ${msg.exitCode}`;
				const message =
					msg.signal === "SIGKILL" && msg.oomKills > 0
						? `agent process was killed (${reason}); the kernel OOM killer killed ${msg.oomKills} process(es) in the worker meanwhile, so it most likely ran out of memory`
						: `agent process exited with ${reason}`;
				if (run.aborted) finishRun(run, abortedOutcome(run, run.aborted), "aborted");
				else finishRun(run, { ok: false, error: { name: "Error", message }, usage: run.usage }, "failed");
				send(conn, { t: "lease-invalid", runId: msg.runId });
				return;
			}
			case "credential-request":
				if (!heldRun(conn, msg.runId)) {
					send(conn, { t: "credential-response", runId: msg.runId, requestId: msg.requestId, ok: false, error: "no such run" });
					return;
				}
				void answerCredential(conn, msg);
				return;
		}
	}

	function onClose(conn: Conn): void {
		if (conn.closed) return;
		conn.closed = true;
		if (conn.runId) released.set(conn.address, Date.now());
		conn.open = false;
		conns.delete(conn.ws.data);
		clearTimeout(conn.claimTimer);
		const index = claimers.indexOf(conn);
		if (index >= 0) claimers.splice(index, 1);
		if (conn.runId) {
			const run = byId.get(conn.runId);
			if (run?.conn === conn) run.conn = undefined;
		}
		if (conn.workerId) log("info", "worker disconnected", { worker: conn.workerId, run: conn.runId });
	}

	const websocket: WebSocketHandler<WorkerSocketData> = {
		// Bigger than the 4 MiB limit so oversized messages can be logged with their run and type (RUN-16).
		maxPayloadLength: 16 * 1024 * 1024,
		open(ws) {
			conns.set(ws.data, { ws, address: ws.data.address, connectedAt: new Date().toISOString(), queue: Promise.resolve(), open: true, closed: false });
		},
		message(ws, raw) {
			const conn = conns.get(ws.data);
			if (!conn) return;
			const text = typeof raw === "string" ? raw : raw.toString("utf8");
			const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
			if (bytes > MAX_WS_MESSAGE_BYTES) {
				const { type, run } = sniff(text);
				log("warn", "worker message over 4 MiB rejected", { worker: conn.workerId, run, type, bytes });
				return;
			}
			let msg: UpMessage;
			try {
				msg = JSON.parse(text) as UpMessage;
			} catch {
				log("warn", "worker message is not JSON", { worker: conn.workerId, bytes });
				return;
			}
			conn.queue = conn.queue
				.then(() => onMessage(conn, msg))
				.catch(err => log("error", "worker message failed", { worker: conn.workerId, type: msg.t, error: errorMessage(err) }));
		},
		close(ws) {
			const conn = conns.get(ws.data);
			if (!conn) return;
			// Messages that arrived before the close are still handled, in order.
			conn.open = false;
			conn.queue = conn.queue.then(() => onClose(conn));
		},
	};

	// ── Start: RUN-07 ────────────────────────────────────────────────────────────────────────

	// NFR-03: a run still pending has no worker, so its row is finished; its turn is kept for the reattach grace so the
	// thread's engine, re-attaching on start, re-issues the same turn.
	const reissue = new Map<string, RunRequest>();
	for (const row of db.runsInState("pending")) {
		const turn = parseJson<RunRequest>(row.request);
		if (turn) reissue.set(row.thread_id, turn);
		dropOrphan(row);
	}
	const reissueExpiry = setTimeout(() => reissue.clear(), opts.reattachGraceMs);
	for (const row of db.runsInState("lost", "finishing")) {
		const run = ensureRun(row);
		finishRun(run, { ok: false, error: { name: "RunLost", message: new RunLost().message }, usage: ZERO_USAGE }, "lost");
	}
	db.graceLeases(opts.reattachGraceMs);
	const sweeper = setInterval(() => guard("lease sweep", sweep), opts.sweepMs ?? 1000);

	// ── Dispatcher API ──────────────────────────────────────────────────────────────────────

	function attach(run: Run, req: RunRequest, hooks: RunHooks, signal: AbortSignal | undefined): Promise<RunResult> {
		const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
		if (signal?.aborted) {
			reject(new RunDetached());
			return promise;
		}
		// The turn stays the one requested first (an engine re-attaching after a restart asks with no turn of its own).
		run.req ??= req;
		const previous = run.caller;
		if (previous) {
			previous.cleanup();
			previous.reject(new RunDetached());
		}
		const onAbort = () => {
			if (run.caller !== caller) return;
			run.caller = undefined;
			caller.cleanup();
			reject(new RunDetached());
		};
		const caller: Caller = { hooks, resolve, reject, cleanup: () => signal?.removeEventListener("abort", onAbort) };
		signal?.addEventListener("abort", onAbort, { once: true });
		run.caller = caller;
		if (run.outcome) {
			deliver(run);
			return promise;
		}
		const state = rowState(run);
		if (!run.id || state === "pending" || state === "assigned") guard("waiting sink", () => hooks.onWaitingForWorker?.(), { run: run.id });
		// Abort and steering work from the start: a run no worker started is finished at once (RUN-05); steers wait (⏳) for `registered` (RUN-15).
		guard("register sink", () => hooks.register(run.handle), { run: run.id });
		if (state === "pending") match();
		return promise;
	}

	return {
		runAgent(req, hooks, signal) {
			const key = req.threadId;
			let run = runs.get(key);
			if (!run) {
				const row = db.currentRun(key);
				if (row) run = ensureRun(row);
			}
			if (run) return attach(run, req, hooks, signal);
			if (signal?.aborted) return Promise.reject(new RunDetached());
			const kept = reissue.get(key);
			reissue.delete(key);
			const turnReq = kept ?? req;
			if (kept) log("info", "pending run re-issued after restart", { thread: key });
			const reason = unrunnableReason(turnReq);
			if (reason) return Promise.reject(new Error(reason));
			const fresh = newRun(key, turnReq);
			runs.set(key, fresh);
			waiting.push(fresh);
			const result = attach(fresh, turnReq, hooks, signal);
			admit();
			return result;
		},
		hasRun(threadId) {
			return runs.has(threadId) || reissue.has(threadId) || db.currentRun(threadId) !== null;
		},
		hasUnfinishedRun(threadId) {
			const run = runs.get(threadId);
			if (run) return !run.outcome;
			if (reissue.has(threadId)) return true;
			const row = db.currentRun(threadId);
			return row !== null && row.state !== "finished";
		},
		counts() {
			let pending = 0;
			let running = 0;
			let oldest: number | undefined;
			for (const row of db.runsInState("pending", "assigned", "running", "finishing")) {
				if (row.state !== "pending") {
					running++;
					continue;
				}
				pending++;
				const since = Date.parse(row.created_at);
				if (oldest === undefined || since < oldest) oldest = since;
			}
			return { pending, running, oldestPendingMs: oldest === undefined ? null : Date.now() - oldest };
		},
		activeRuns() {
			return db.runsInState("pending", "assigned", "running", "finishing").map(row => {
				const run = byId.get(row.id);
				const claimed = row.state !== "pending" && row.claimed_at ? row.claimed_at : undefined;
				const status: RunStatus = {
					id: row.id,
					state: row.state as RunStatus["state"],
					threadId: row.thread_id,
					createdAt: row.created_at,
					usage: run?.usage ?? ZERO_USAGE,
				};
				if (row.worker_id && row.state !== "pending") status.workerId = row.worker_id;
				if (claimed) status.claimedAt = claimed;
				if (row.started_at) status.startedAt = row.started_at;
				if (claimed && row.started_at) status.setupMs = Math.max(0, Date.parse(row.started_at) - Date.parse(claimed));
				if (run?.lastTool) status.lastTool = run.lastTool;
				if (run?.loadout) status.loadout = run.loadout;
				return status;
			});
		},
		workers() {
			const list: WorkerStatus[] = [];
			for (const conn of conns.values()) {
				if (!conn.workerId) continue;
				list.push({
					id: conn.workerId,
					address: conn.address,
					version: conn.version ?? "",
					ompVersion: conn.runOmpVersion ?? conn.ompVersion ?? "",
					...(conn.runId ? { runId: conn.runId } : {}),
					...(conn.phase ? { phase: conn.phase } : {}),
					connectedAt: conn.connectedAt,
				});
			}
			return list;
		},
		pendingRuns: () => db.runsInState("pending").length,
		socketData: address => ({ address }),
		websocket,
		artifact: req => artifacts.handle(req),
		close() {
			clearInterval(sweeper);
			clearTimeout(reissueExpiry);
			for (const conn of claimers.splice(0)) clearTimeout(conn.claimTimer);
		},
	};
}
