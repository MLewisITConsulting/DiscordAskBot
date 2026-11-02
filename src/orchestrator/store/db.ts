import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** An `/ask` thread (DB-02): who started it where, its omp session and its scratch directory (CHAT-07). */
export interface AskChatRow {
	thread_id: string;
	/** The ask-only channel the thread was started in. */
	channel_id: string;
	/** Discord user id of the person who started the thread. */
	owner_id: string;
	/** Session key once a run stored a session (`<state>/sessions/<key>.jsonl`); null before the first. */
	session_file: string | null;
	/** The thread's scratch directory; null after an idle sweep removed it (CHAT-06, CHAT-11). */
	scratch_dir: string | null;
	last_active_at: string;
}

/** Architecture §4.1. `lost` is transient: the dispatcher finishes a lost run as failed (RUN-04). */
export type RunState = "pending" | "assigned" | "running" | "finishing" | "finished" | "lost";
export type RunOutcome = "succeeded" | "failed" | "aborted" | "cancelled" | "lost";

/** One ask turn on its own worker (architecture §4.1), owned by its ask thread. */
export interface RunRow {
	id: string;
	state: RunState;
	/** The ask thread that owns the run; also where its status message lives (RUN-14). */
	thread_id: string;
	worker_id: string | null;
	/** Network address of the connection that claimed the run (architecture §6: one claim per address; kept after it finishes). */
	worker_address: string | null;
	/** sha256 (hex) of the token that authorises the worker's heartbeats and artifact requests (RUN-02, SEC-14); the token itself is never stored. */
	lease_token: string | null;
	lease_expires_at: string | null;
	loss_count: number;
	omp_version: string | null;
	/** The thread's previous run, whose session this run resumes (DB-02). */
	continues_run_id: string | null;
	/** The live status message (RUN-14). */
	status_message_id: string | null;
	/** JSON of the latest `progress` snapshot (RUN-14). */
	progress: string | null;
	/** Last relay sequence number given to an outgoing message (RUN-06). */
	relay_out_seq: number;
	/** Highest relay sequence number received from the worker and stored (RUN-06). */
	relay_in_seq: number;
	/** The run's omp session key: `<state>/sessions/<key>.jsonl`. */
	session_key: string | null;
	/** The thread's scratch directory in the orchestrator (CHAT-07). */
	scratch_dir: string | null;
	/** JSON of the run request's serialisable turn (see `NewRun.request`). */
	request: string | null;
	/**
	 * JSON of the run's outcome while no attached caller has received it yet (the `Dispatcher` contract: results are kept
	 * until delivered, across restarts too); null once delivered or when the run never produced one.
	 */
	result: string | null;
	outcome: RunOutcome | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	/** The latest claim by a worker (RUN-02); with `started_at`, the run's setup time (NFR-06). */
	claimed_at: string | null;
	/** The agent started (`registered`). */
	started_at: string | null;
	finished_at: string | null;
}

/** An orchestrator → worker relay message not yet acknowledged by the worker (RUN-06). */
export interface OutboxRow {
	run_id: string;
	seq: number;
	/** JSON of the relayed message. */
	payload: string;
	created_at: string;
}

export type AskChatPatch = Partial<Pick<AskChatRow, "session_file" | "scratch_dir" | "last_active_at">>;
export type RunPatch = Partial<Pick<RunRow, "omp_version" | "status_message_id" | "progress" | "outcome" | "error" | "result">>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ask_chats(
	thread_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, owner_id TEXT NOT NULL, session_file TEXT, scratch_dir TEXT,
	last_active_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ask_chats_owner ON ask_chats(owner_id);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_runs(
	id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, outcome TEXT NOT NULL,
	oom_kills INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, cost_usd REAL NOT NULL,
	tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_runs_finished ON agent_runs(finished_at);
CREATE TABLE IF NOT EXISTS runs(
	id TEXT PRIMARY KEY, state TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES ask_chats(thread_id),
	worker_id TEXT, worker_address TEXT, lease_token TEXT UNIQUE, lease_expires_at TEXT, loss_count INTEGER NOT NULL DEFAULT 0,
	omp_version TEXT, continues_run_id TEXT REFERENCES runs(id), status_message_id TEXT, progress TEXT,
	relay_out_seq INTEGER NOT NULL DEFAULT 0, relay_in_seq INTEGER NOT NULL DEFAULT 0, session_key TEXT, scratch_dir TEXT,
	request TEXT, result TEXT, outcome TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claimed_at TEXT,
	started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS runs_active_thread ON runs(thread_id) WHERE state != 'finished';
CREATE TABLE IF NOT EXISTS relay_outbox(
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, payload TEXT NOT NULL,
	created_at TEXT NOT NULL, PRIMARY KEY(run_id, seq));
CREATE TABLE IF NOT EXISTS worker_claims(worker_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, claimed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worker_addresses(worker_id TEXT PRIMARY KEY, address TEXT NOT NULL, first_seen_at TEXT NOT NULL);
`;

/** Tokens and cost consumed by one agent run (the shape of `RunUsage`). */
export interface UsageRecord {
	costUsd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** How an ask turn ended, for the usage report's run counts (OBS-06). */
export type AgentRunOutcome = "finished" | "failed" | "stopped" | "limit";

/** One agent run's usage: the unit of usage accounting for the status page (OBS-05). */
export interface AgentRunRecord {
	threadId: string;
	channelId: string;
	userId: string;
	outcome: AgentRunOutcome;
	/** Kernel OOM kills during the turn (AGT-19). */
	oomKills?: number;
	startedAt: string;
	usage: UsageRecord;
}

/** A new pending run of an ask thread. */
export interface NewRun {
	threadId: string;
	continuesRunId?: string;
	sessionKey?: string;
	scratchDir?: string;
	/** The serialisable part of the run's request (prompt, session, limits …), JSON; lets a run still pending at a restart be re-issued (NFR-03). */
	request?: string;
}

/** Runs whose lease ran out: `requeued` went back to `pending` (never started), `lost` died while running. */
export interface ExpiredLeases {
	requeued: RunRow[];
	lost: RunRow[];
}

const ASK_CHAT_COLUMNS: Record<keyof AskChatPatch, true> = {
	session_file: true,
	scratch_dir: true,
	last_active_at: true,
};

const RUN_COLUMNS: Record<keyof RunPatch, true> = {
	omp_version: true,
	status_message_id: true,
	progress: true,
	outcome: true,
	error: true,
	result: true,
};

/** Typed access to the AskBot SQLite store. */
export interface Db {
	raw: Database;
	close(): void;

	/** Records a new ask thread started by `ownerId` in `channelId`. */
	insertAskChat(threadId: string, channelId: string, ownerId: string): AskChatRow;
	getAskChat(threadId: string): AskChatRow | null;
	updateAskChat(threadId: string, patch: AskChatPatch): void;
	/** Ask threads started by `ownerId` (DSC-06). */
	askChatsOf(ownerId: string): AskChatRow[];
	allAskChats(): AskChatRow[];
	/** Ask threads that still have a scratch directory and were idle since before `cutoffIso` (CHAT-06). */
	idleAskChats(cutoffIso: string): AskChatRow[];

	kvGet(key: string): string | undefined;
	kvSet(key: string, value: string): void;
	/** Append one agent run's usage (stamped with the current time as `finished_at`). */
	recordRun(run: AgentRunRecord): void;

	/** Inserts a `pending` run. Throws when its thread already has a run that is not `finished` (RUN-21). */
	insertRun(run: NewRun): RunRow;
	getRun(id: string): RunRow | null;
	/** Runs in any of `states`, oldest first. */
	runsInState(...states: RunState[]): RunRow[];
	/** The thread's current run: the newest one that is not `finished` or still holds an undelivered `result`. */
	currentRun(threadId: string): RunRow | null;
	/** The thread's newest run in any state. */
	latestRun(threadId: string): RunRow | null;
	/**
	 * Atomically assigns the oldest pending run to `workerId` with a fresh lease of `leaseMs` (RUN-02), recording the
	 * claiming connection's `address`.
	 */
	claimRun(workerId: string, leaseMs: number, address?: string): ClaimedRun | null;
	/** Extends the lease if `token` still holds run `id` (assigned, running or finishing); null otherwise. */
	renewLease(id: string, token: string, leaseMs: number): RunRow | null;
	/** The run a live lease token belongs to; null when the token is unknown or the run no longer holds it. */
	runForLease(token: string): RunRow | null;
	/**
	 * Expires leases that ran out before `at`: `assigned` runs go back to `pending`, `running` runs become `lost`
	 * with their loss count raised (RUN-02, RUN-04). The tokens are revoked.
	 */
	expireLeases(at?: Date): ExpiredLeases;
	/** After a restart, gives every `assigned`/`running` run at least `graceMs` to re-announce (RUN-07). */
	graceLeases(graceMs: number): void;
	/**
	 * Moves run `id` to `to` only if it is in one of `from`; null when it was not. Moving to `pending` releases the
	 * worker and lease; to `finished` revokes the lease and stamps `finished_at`; to `running` stamps `started_at`.
	 */
	transitionRun(id: string, from: RunState[], to: RunState, patch?: RunPatch): RunRow | null;
	updateRun(id: string, patch: RunPatch): RunRow;

	/** Stores an outgoing relay message under the run's next sequence number and returns that number (RUN-06). */
	appendOutbox(runId: string, payload: unknown): number;
	/** Unacknowledged outgoing messages of the run in sequence order (resent after a reconnect). */
	outbox(runId: string): OutboxRow[];
	/** Drops the run's outgoing messages up to and including `seq`; returns how many were dropped. */
	ackOutbox(runId: string, seq: number): number;
	/** Records an incoming relay sequence number; false when it was already received (a duplicate to drop). */
	acceptInbound(runId: string, seq: number): boolean;
	/** The run id `workerId` claimed, if it ever claimed one (one claim per worker id, architecture §6). */
	workerClaim(workerId: string): string | null;
	/** Records the one claim of `workerId`; false when it already has one. */
	recordWorkerClaim(workerId: string, runId: string): boolean;
	/**
	 * True when a run claimed from `address` still holds its lease, is `lost`, or finished at or after `since`
	 * (architecture §6: one claim per network address).
	 */
	addressHoldsRun(address: string, since: Date): boolean;
	/** The address `workerId` first said hello from, recording `address` when it is new (architecture §6). */
	bindWorkerAddress(workerId: string, address: string): string;
}

const now = () => new Date().toISOString();

/** The database file inside the state directory (DB-01). */
export function dbPath(stateDir: string): string {
	return join(stateDir, "askbot.db");
}

type Params = Record<string, string | number | null>;

/** sha256 hex of a lease token: what the runs table stores and looks up, so the SQL comparison leaks nothing (SEC-14). */
export function hashLeaseToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** A run just claimed, with its lease token (returned to the claimer once; only its hash is stored). */
export type ClaimedRun = RunRow & { leaseToken: string };

/** Open (and create) the store at `path` (`dbPath(stateDir)`). Pass `":memory:"` for tests and dry-run. */
export function openDb(path: string): Db {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode=WAL");
	// Under WAL, NORMAL fsyncs at checkpoints instead of at every commit: a commit still survives a process crash, and
	// only an OS crash or power loss can lose the last few. FULL blocked the event loop (bun:sqlite is synchronous) for up
	// to 17 s in AgentBot's load test, when 10 workers kept the node's disk busy (architecture §5).
	db.run("PRAGMA synchronous=NORMAL");
	db.run("PRAGMA foreign_keys=ON");
	db.run("PRAGMA busy_timeout=5000");
	db.transaction(() => {
		for (const stmt of SCHEMA.split(";")) if (stmt.trim()) db.run(stmt);
	})();

	const q = {
		askChat: db.query<AskChatRow, [string]>("SELECT * FROM ask_chats WHERE thread_id = ?"),
		insertAskChat: db.query<AskChatRow, [string, string, string, string]>(
			"INSERT INTO ask_chats(thread_id, channel_id, owner_id, last_active_at) VALUES (?, ?, ?, ?) RETURNING *",
		),
		askChatsOf: db.query<AskChatRow, [string]>("SELECT * FROM ask_chats WHERE owner_id = ?"),
		allAskChats: db.query<AskChatRow, []>("SELECT * FROM ask_chats"),
		idleAskChats: db.query<AskChatRow, [string]>("SELECT * FROM ask_chats WHERE scratch_dir IS NOT NULL AND last_active_at < ?"),
		kvGet: db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?"),
		kvSet: db.query<null, [string, string]>(
			"INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		),
		recordRun: db.query<null, [string, string, string, string, number, string, string, number, number, number, number, number]>(
			`INSERT INTO agent_runs(thread_id, channel_id, user_id, outcome, oom_kills, started_at, finished_at, cost_usd,
				tokens_in, tokens_out, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		),

		insertRun: db.query<RunRow, [Params]>(
			`INSERT INTO runs(id, state, thread_id, continues_run_id, session_key, scratch_dir, request, created_at, updated_at)
			VALUES ($id, 'pending', $thread_id, $continues_run_id, $session_key, $scratch_dir, $request, $now, $now) RETURNING *`,
		),
		runById: db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?"),
		currentRun: db.query<RunRow, [string]>(
			"SELECT * FROM runs WHERE thread_id = ? AND (state != 'finished' OR result IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT 1",
		),
		latestRun: db.query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
		claimRun: db.query<RunRow, [string, string, string, string, string | null]>(
			`UPDATE runs SET state = 'assigned', worker_id = ?1, lease_token = ?2, lease_expires_at = ?3, updated_at = ?4, claimed_at = ?4,
				worker_address = ?5
			WHERE id = (SELECT id FROM runs WHERE state = 'pending' ORDER BY created_at, rowid LIMIT 1) RETURNING *`,
		),
		renewLease: db.query<RunRow, [string, string, string, string]>(
			`UPDATE runs SET lease_expires_at = ?1, updated_at = ?2
			WHERE id = ?3 AND lease_token = ?4 AND state IN ('assigned', 'running', 'finishing') RETURNING *`,
		),
		runForLease: db.query<RunRow, [string]>(
			"SELECT * FROM runs WHERE lease_token = ? AND state IN ('assigned', 'running', 'finishing')",
		),
		expireAssigned: db.query<RunRow, [string]>(
			`UPDATE runs SET state = 'pending', worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?1
			WHERE state = 'assigned' AND lease_expires_at < ?1 RETURNING *`,
		),
		expireRunning: db.query<RunRow, [string]>(
			`UPDATE runs SET state = 'lost', loss_count = loss_count + 1, lease_token = NULL, lease_expires_at = NULL,
				updated_at = ?1
			WHERE state = 'running' AND lease_expires_at < ?1 RETURNING *`,
		),
		graceLeases: db.query<null, [string]>(
			`UPDATE runs SET lease_expires_at = ?1
			WHERE state IN ('assigned', 'running') AND (lease_expires_at IS NULL OR lease_expires_at < ?1)`,
		),
		bumpOutSeq: db.query<{ relay_out_seq: number }, [string]>(
			"UPDATE runs SET relay_out_seq = relay_out_seq + 1 WHERE id = ? RETURNING relay_out_seq",
		),
		insertOutbox: db.query<null, [string, number, string, string]>(
			"INSERT INTO relay_outbox(run_id, seq, payload, created_at) VALUES (?, ?, ?, ?)",
		),
		outbox: db.query<OutboxRow, [string]>("SELECT * FROM relay_outbox WHERE run_id = ? ORDER BY seq"),
		ackOutbox: db.query<null, [string, number]>("DELETE FROM relay_outbox WHERE run_id = ? AND seq <= ?"),
		acceptInbound: db.query<{ relay_in_seq: number }, [number, string]>(
			"UPDATE runs SET relay_in_seq = ?1 WHERE id = ?2 AND relay_in_seq < ?1 RETURNING relay_in_seq",
		),
		workerClaim: db.query<{ run_id: string }, [string]>("SELECT run_id FROM worker_claims WHERE worker_id = ?"),
		recordWorkerClaim: db.query<null, [string, string, string]>(
			"INSERT OR IGNORE INTO worker_claims(worker_id, run_id, claimed_at) VALUES (?, ?, ?)",
		),
		addressHoldsRun: db.query<{ id: string }, [string, string]>(
			`SELECT id FROM runs WHERE worker_address = ?1
				AND (state IN ('assigned', 'running', 'finishing', 'lost') OR finished_at >= ?2) LIMIT 1`,
		),
		recordWorkerAddress: db.query<null, [string, string, string]>(
			"INSERT OR IGNORE INTO worker_addresses(worker_id, address, first_seen_at) VALUES (?, ?, ?)",
		),
		workerAddress: db.query<{ address: string }, [string]>("SELECT address FROM worker_addresses WHERE worker_id = ?"),
	};

	/**
	 * `UPDATE table SET <allowed patch columns> [, updated_at] WHERE key [AND where] RETURNING *`. Null when no row
	 * matched or there is nothing to set.
	 */
	function patchRow<T>(
		table: string,
		keyColumn: string,
		key: string | number,
		columns: Record<string, true>,
		patch: object,
		extra: { stamp?: boolean; sets?: string[]; where?: string; params?: Params } = {},
	): T | null {
		const entries = Object.entries(patch).filter(([k]) => k in columns);
		const params: Params = { key, ...extra.params };
		for (const [k, v] of entries) params[k] = (v as string | number | null | undefined) ?? null;
		const sets = entries.map(([k]) => `${k} = $${k}`).concat(extra.sets ?? []);
		if (extra.stamp !== false) {
			params.updated_at = now();
			sets.push("updated_at = $updated_at");
		}
		if (!sets.length) return null;
		const where = `${keyColumn} = $key${extra.where ? ` AND ${extra.where}` : ""}`;
		return db.query<T, [Params]>(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${where} RETURNING *`).get(params);
	}

	function transitionRun(id: string, from: RunState[], to: RunState, patch: RunPatch = {}): RunRow | null {
		const sets = ["state = $to"];
		if (to === "pending") sets.push("worker_id = NULL", "lease_token = NULL", "lease_expires_at = NULL");
		if (to === "finished") sets.push("lease_token = NULL", "lease_expires_at = NULL", "finished_at = $updated_at");
		if (to === "running") sets.push("started_at = COALESCE(started_at, $updated_at)");
		const params: Params = { to };
		const fromNames = from.map((state, i) => {
			params[`from${i}`] = state;
			return `$from${i}`;
		});
		if (!fromNames.length) return null;
		return patchRow<RunRow>("runs", "id", id, RUN_COLUMNS, patch, {
			sets,
			where: `state IN (${fromNames.join(", ")})`,
			params,
		});
	}

	return {
		raw: db,
		close: () => db.close(),

		insertAskChat: (threadId, channelId, ownerId) => q.insertAskChat.get(threadId, channelId, ownerId, now())!,
		getAskChat: threadId => q.askChat.get(threadId),
		updateAskChat: (threadId, patch) => {
			patchRow<AskChatRow>("ask_chats", "thread_id", threadId, ASK_CHAT_COLUMNS, patch, { stamp: false });
		},
		askChatsOf: ownerId => q.askChatsOf.all(ownerId),
		allAskChats: () => q.allAskChats.all(),
		idleAskChats: cutoffIso => q.idleAskChats.all(cutoffIso),

		kvGet: key => q.kvGet.get(key)?.value,
		kvSet: (key, value) => {
			q.kvSet.run(key, value);
		},
		recordRun: run => {
			const { usage } = run;
			q.recordRun.run(
				run.threadId,
				run.channelId,
				run.userId,
				run.outcome,
				run.oomKills ?? 0,
				run.startedAt,
				now(),
				usage.costUsd,
				usage.input,
				usage.output,
				usage.cacheRead,
				usage.cacheWrite,
			);
		},

		insertRun: run =>
			q.insertRun.get({
				id: crypto.randomUUID(),
				thread_id: run.threadId,
				continues_run_id: run.continuesRunId ?? null,
				session_key: run.sessionKey ?? null,
				scratch_dir: run.scratchDir ?? null,
				request: run.request ?? null,
				now: now(),
			})!,
		getRun: id => q.runById.get(id),
		runsInState: (...states) => {
			if (!states.length) return [];
			return db
				.query<RunRow, string[]>(`SELECT * FROM runs WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at, rowid`)
				.all(...states);
		},
		currentRun: threadId => q.currentRun.get(threadId),
		latestRun: threadId => q.latestRun.get(threadId),
		claimRun: (workerId, leaseMs, address) => {
			const at = new Date();
			const leaseToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
			const row = q.claimRun.get(workerId, hashLeaseToken(leaseToken), new Date(at.getTime() + leaseMs).toISOString(), at.toISOString(), address ?? null);
			return row && { ...row, leaseToken };
		},
		renewLease: (id, token, leaseMs) => {
			const at = new Date();
			return q.renewLease.get(new Date(at.getTime() + leaseMs).toISOString(), at.toISOString(), id, hashLeaseToken(token));
		},
		runForLease: token => q.runForLease.get(hashLeaseToken(token)),
		expireLeases: (at = new Date()) =>
			db.transaction(() => {
				const iso = at.toISOString();
				return { requeued: q.expireAssigned.all(iso), lost: q.expireRunning.all(iso) };
			})(),
		graceLeases: graceMs => {
			q.graceLeases.run(new Date(Date.now() + graceMs).toISOString());
		},
		transitionRun,
		updateRun: (id, patch) => {
			const row = patchRow<RunRow>("runs", "id", id, RUN_COLUMNS, patch);
			if (!row) throw new Error(`run ${id} not found`);
			return row;
		},

		appendOutbox: (runId, payload) =>
			db.transaction(() => {
				const bumped = q.bumpOutSeq.get(runId);
				if (!bumped) throw new Error(`run ${runId} not found`);
				q.insertOutbox.run(runId, bumped.relay_out_seq, JSON.stringify(payload), now());
				return bumped.relay_out_seq;
			})(),
		outbox: runId => q.outbox.all(runId),
		ackOutbox: (runId, seq) => q.ackOutbox.run(runId, seq).changes,
		acceptInbound: (runId, seq) => q.acceptInbound.get(seq, runId) !== null,
		workerClaim: workerId => q.workerClaim.get(workerId)?.run_id ?? null,
		recordWorkerClaim: (workerId, runId) => q.recordWorkerClaim.run(workerId, runId, now()).changes === 1,
		addressHoldsRun: (address, since) => q.addressHoldsRun.get(address, since.toISOString()) !== null,
		bindWorkerAddress: (workerId, address) => {
			q.recordWorkerAddress.run(workerId, address, now());
			return q.workerAddress.get(workerId)!.address;
		},
	};
}

export function parseJson<T>(text: string | null): T | undefined {
	return text ? (JSON.parse(text) as T) : undefined;
}
