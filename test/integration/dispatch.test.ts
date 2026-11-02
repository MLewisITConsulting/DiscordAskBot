import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminApi } from "../../src/orchestrator/api/admin";
import { type InternalApi, startInternalApi } from "../../src/orchestrator/api/server";
import { type RunHandle, type RunHooks, RunLost, type RunRequest, type RunResult } from "../../src/orchestrator/dispatch/dispatcher";
import { createWorkerDispatcher, type DispatchLimits, type WorkerDispatcher } from "../../src/orchestrator/dispatch/workers";
import { createController } from "../../src/orchestrator/engine/controller";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, dbPath, openDb } from "../../src/orchestrator/store/db";
import { openVault } from "../../src/orchestrator/store/vault";
import type { ChildMessage } from "../../src/shared/protocol";
import type { RunUsage } from "../../src/shared/transcript";
import { type DownMessage, runArtifactPath, type UpMessage, WORKER_WS_PATH } from "../../src/shared/wire";

/**
 * The dispatcher against scripted WebSocket clients acting as workers (no worker process): claims, the relay in both
 * directions, delivery confirmations, an orchestrator restart over the same database, lost workers, caps and tokens.
 */

const WORKER_TOKEN = "worker-token";
const SCALE_TOKEN = "scale-token";
const WEB_TOKEN = "web-token";
const USAGE: RunUsage = { costUsd: 0.25, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

interface Orchestrator {
	db: Db;
	dispatcher: WorkerDispatcher;
	api: InternalApi;
	/** Stops this "process" without finishing anything (a crash or SIGTERM). */
	stop(): Promise<void>;
}

interface Setup {
	stateDir: string;
	limits: { value: DispatchLimits | undefined };
	start(opts?: { graceMs?: number; bindWorkerAddresses?: boolean }): Promise<Orchestrator>;
}

async function setup(): Promise<Setup> {
	const stateDir = await mkdtemp(join(tmpdir(), "askbot-dispatch-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	const limits: Setup["limits"] = { value: { maxChatSessions: 2, maxConcurrentRuns: 4 } };
	return {
		stateDir,
		limits,
		async start(opts = {}) {
			const db = openDb(dbPath(stateDir));
			const dispatcher = createWorkerDispatcher({
				db,
				stateDir,
				limits: () => limits.value,
				reattachGraceMs: opts.graceMs ?? 2000,
				spec: {
					stateDir,
					ompConfig: () => ({ settings: { "compaction.enabled": true } }),
					providerKeys: () => ({ anthropic: "sk-test" }),
					credentials: async () => [{ id: 1, provider: "p", credential: { refresh: "__remote__" } }],
					skillsHash: async () => "skills-hash",
				},
				skills: async () => ({ hash: "skills-hash", tar: new TextEncoder().encode("tar-bytes") }),
				credentialRequest: async req => ({ ok: true, accessToken: `fresh-${req.credentialId}`, expiresAt: 42 }),
				claimWaitMs: 1500,
				leaseMs: 600,
				sweepMs: 25,
				// Every fake worker connects from 127.0.0.1; only the architecture §6 test turns this on.
				bindWorkerAddresses: opts.bindWorkerAddresses ?? false,
			});
			// The real admin API (SEC-14: only the web token gets past it); the controller is never started here.
			const vault = await openVault(db);
			const controller = createController({
				stateDir,
				ompDir: join(stateDir, "omp"),
				db,
				vault,
				agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
				dispatcher,
			});
			const admin = createAdminApi({ db, vault, controller, dispatcher, version: "0.0.0-test", workerCapacity: 4, webToken: WEB_TOKEN, setupToken: undefined });
			const api = startInternalApi({
				host: "127.0.0.1",
				port: 0,
				stateDir,
				db,
				version: "0.0.0-test",
				workerCapacity: 4,
				phase: () => "running",
				config: () => undefined,
				dispatcher,
				admin,
				workers: dispatcher,
				workerToken: WORKER_TOKEN,
				scaleToken: SCALE_TOKEN,
			});
			let stopped = false;
			const stop = async () => {
				if (stopped) return;
				stopped = true;
				dispatcher.close();
				await api.stop();
				db.close();
			};
			cleanups.push(stop);
			return { db, dispatcher, api, stop };
		},
	};
}

/** A WebSocket to the worker endpoint with `token`; undefined when the connection is refused. */
async function openSocket(url: string, token: string): Promise<WebSocket | undefined> {
	// Bun takes headers in the options object; the DOM typings only know protocols.
	const options: Bun.WebSocketOptions = { headers: { Authorization: `Bearer ${token}` } };
	const ws = new WebSocket(`${url.replace(/^http/, "ws")}${WORKER_WS_PATH}`, options as unknown as string[]);
	const { promise, resolve } = Promise.withResolvers<WebSocket | undefined>();
	ws.addEventListener("open", () => resolve(ws), { once: true });
	ws.addEventListener("error", () => resolve(undefined), { once: true });
	return promise;
}

/** A scripted worker: one WebSocket, relaying host messages with its own sequence numbers. */
class FakeWorker {
	readonly inbox: DownMessage[] = [];
	private seq = new Map<string, number>();
	private closed = false;
	autoAck = true;

	private constructor(
		readonly id: string,
		private readonly ws: WebSocket,
	) {
		ws.addEventListener("message", event => {
			const msg = JSON.parse(String(event.data)) as DownMessage;
			this.inbox.push(msg);
			if (this.autoAck && msg.t === "relay") this.send({ t: "ack", runId: msg.runId, seq: msg.seq });
		});
		ws.addEventListener("close", () => {
			this.closed = true;
		});
		cleanups.push(() => this.close());
	}

	static async connect(url: string, id: string, lease?: { runId: string; token: string }): Promise<FakeWorker> {
		const ws = await openSocket(url, WORKER_TOKEN);
		if (!ws) throw new Error("worker connection failed");
		const worker = new FakeWorker(id, ws);
		worker.send({ t: "hello", workerId: id, identity: { version: "0.0.0-test", hash: "h" }, ompVersion: "18.12.1", ...(lease ? { lease } : {}) });
		return worker;
	}

	send(msg: UpMessage): void {
		this.ws.send(JSON.stringify(msg));
	}

	sendRaw(text: string): void {
		this.ws.send(text);
	}

	/** Relays a host message up; returns its sequence number. */
	relay(runId: string, msg: ChildMessage, seq?: number): number {
		const next = seq ?? (this.seq.get(runId) ?? 0) + 1;
		this.seq.set(runId, Math.max(next, this.seq.get(runId) ?? 0));
		this.send({ t: "relay", runId, seq: next, msg });
		return next;
	}

	/** The first message so far matching `pred`, waiting for it. */
	async next<T extends DownMessage>(pred: (msg: DownMessage) => msg is T, what: string): Promise<T>;
	async next(pred: (msg: DownMessage) => boolean, what: string): Promise<DownMessage>;
	async next(pred: (msg: DownMessage) => boolean, what: string): Promise<DownMessage> {
		await until(() => this.inbox.some(pred), what);
		return this.inbox.find(pred)!;
	}

	/** The relayed host message down matching `pred`. */
	async down(pred: (msg: Extract<DownMessage, { t: "relay" }>["msg"]) => boolean, what: string) {
		const found = await this.next(m => m.t === "relay" && pred(m.msg), what);
		return found as Extract<DownMessage, { t: "relay" }>;
	}

	async claim(): Promise<Extract<DownMessage, { t: "assign" }>> {
		this.send({ t: "claim" });
		return (await this.next(m => m.t === "assign", "assign")) as Extract<DownMessage, { t: "assign" }>;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.ws.close();
	}
}

function askRequest(threadId: string, over: Partial<RunRequest> = {}): RunRequest {
	return {
		threadId,
		profile: "ask",
		prompt: "What is in a.txt?",
		thinking: "high",
		limits: { minutes: 10, costUsd: 1 },
		session: `chat-${threadId}`,
		resume: false,
		scratchDir: join(tmpdir(), "askbot-dispatch-no-scratch", threadId),
		...over,
	};
}

interface Recorder {
	hooks: RunHooks;
	handles: RunHandle[];
	usage: RunUsage[];
	waiting: number;
	progress: unknown[];
}

function recorder(): Recorder {
	const r: Recorder = {
		handles: [],
		usage: [],
		waiting: 0,
		progress: [],
		hooks: undefined as unknown as RunHooks,
	};
	r.hooks = {
		register: handle => void r.handles.push(handle),
		onWaitingForWorker: () => void r.waiting++,
		onProgress: p => void r.progress.push(p),
		onUsage: u => void r.usage.push(u),
	};
	return r;
}

async function chatThread(db: Db, threadId: string): Promise<void> {
	db.insertAskChat(threadId, "c1", "u1");
}

function bearer(token: string): RequestInit {
	return { headers: { Authorization: `Bearer ${token}` } };
}

describe("worker dispatcher", () => {
	test("an ask run: claim, artifacts, relay both ways, done with outputs (RUN-02, RUN-06, RUN-18, RUN-19, CHAT-07)", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		const scratchDir = join(s.stateDir, "scratch", "t1");
		await mkdir(join(scratchDir, "inputs"), { recursive: true });
		await writeFile(join(scratchDir, "inputs", "a.txt"), "hello");
		const rec = recorder();
		const resultP = o.dispatcher.runAgent(askRequest("t1", { scratchDir }), rec.hooks);
		expect(rec.waiting).toBe(1);
		expect(o.dispatcher.counts()).toMatchObject({ pending: 1, running: 0 });
		expect(o.dispatcher.hasUnfinishedRun("t1")).toBe(true);
		expect(await (await fetch(`${o.api.url}/internal/scale`, bearer(SCALE_TOKEN))).json()).toEqual({ pendingRuns: 1 });

		const w = await FakeWorker.connect(o.api.url, "worker-1");
		const assign = await w.claim();
		const { runId, token, spec } = assign;
		expect(spec).toMatchObject({
			runId,
			profile: "ask",
			resumeSession: false,
			omp: { settings: { "compaction.enabled": true } },
			skillsHash: "skills-hash",
			providerKeys: { anthropic: "sk-test" },
			scratch: { inputs: ["a.txt"] },
		});
		expect(spec.credentials).toHaveLength(1);
		expect(o.dispatcher.counts()).toMatchObject({ pending: 0, running: 1 });
		expect(o.dispatcher.workers()).toMatchObject([{ id: "worker-1", runId, ompVersion: "18.12.1" }]);

		// Artifacts with the lease token.
		const art = (name: string) => `${o.api.url}${runArtifactPath(runId, name)}`;
		expect(await (await fetch(art("skills"), bearer(token))).text()).toBe("tar-bytes");
		expect(await (await fetch(art("scratch/inputs/a.txt"), bearer(token))).text()).toBe("hello");
		expect((await fetch(art("session"), bearer(token))).status).toBe(404);
		expect((await fetch(art("session"), { method: "PUT", body: '{"type":"session"}\n', ...bearer(token) })).status).toBe(204);
		expect(await (await fetch(art("session"), bearer(token))).text()).toBe('{"type":"session"}\n');
		expect((await fetch(art("scratch/outputs/notes.md"), { method: "PUT", body: "# notes", ...bearer(token) })).status).toBe(204);
		expect((await fetch(art("scratch/outputs/..hidden"), { method: "PUT", body: "x", ...bearer(token) })).status).toBe(400);

		w.send({ t: "heartbeat", runId, token, phase: "running" });
		w.send({ t: "run-info", runId, ompVersion: "18.12.2" });
		w.relay(runId, { t: "session_file", id: 1, path: "/run/session.jsonl" });
		expect((await w.down(m => m.t === "reply" && m.id === 1, "session_file reply")).msg).toEqual({ t: "reply", id: 1, ok: true });
		w.relay(runId, { t: "registered" });
		await until(() => o.db.getRun(runId)?.state === "running", "running");
		expect(rec.handles).toHaveLength(1);
		w.relay(runId, { t: "progress", tool: "read", intent: "reading a.txt", usage: USAGE, elapsedMs: 1200 });
		w.send({ t: "session-upload", runId });
		await until(() => rec.progress.length === 1, "progress");
		expect(rec.progress[0]).toMatchObject({ tool: "read", intent: "reading a.txt", elapsedMs: 1200 });

		// Sign-in refresh through the orchestrator (CRED-03).
		w.send({ t: "credential-request", runId, requestId: 5, provider: "p", credentialId: "1", accessToken: "old" });
		expect(await w.next(m => m.t === "credential-response", "credential response")).toEqual({
			t: "credential-response",
			runId,
			requestId: 5,
			ok: true,
			accessToken: "fresh-1",
			expiresAt: 42,
		});

		// Steering while registered: delivered once the host replies ok (👀).
		let queued = 0;
		const steered = rec.handles[0]!.steer("also check b", "bob", { onQueued: () => void queued++ });
		const steerMsg = await w.down(m => m.t === "steer", "steer");
		expect(steerMsg.msg).toMatchObject({ text: "[Discord @bob]: also check b" });
		w.relay(runId, { t: "reply", id: steerMsg.msg.id, ok: true });
		expect(await steered).toBe("delivered");
		expect(queued).toBe(0);

		// Duplicates are dropped but acknowledged.
		const dup = w.relay(runId, { t: "progress", usage: USAGE, elapsedMs: 1300 });
		w.relay(runId, { t: "progress", usage: USAGE, elapsedMs: 1300 }, dup);
		await until(() => w.inbox.filter(m => m.t === "ack" && m.seq === dup).length === 2, "two acks");
		expect(rec.progress).toHaveLength(2);

		w.relay(runId, { t: "usage", usage: USAGE });
		const doneSeq = w.relay(runId, {
			t: "done",
			result: { output: { answer: "It says hello." }, sessionFile: "/run/session.jsonl", usage: USAGE, oomKills: 0 },
		});
		const result: RunResult = await resultP;
		expect(result).toMatchObject({ output: { answer: "It says hello." }, usage: USAGE, oomKills: 0, hasSession: true, outputs: ["notes.md"] });
		expect(rec.usage).toEqual([USAGE]);
		await w.next(m => m.t === "ack" && m.seq === doneSeq, "ack of done");
		expect(o.db.getRun(runId)).toMatchObject({ state: "finished", outcome: "succeeded", result: null, omp_version: "18.12.2" });
		expect(o.dispatcher.hasUnfinishedRun("t1")).toBe(false);
		expect(o.dispatcher.counts()).toEqual({ pending: 0, running: 0, oldestPendingMs: null });
		// The lease died with the run.
		expect((await fetch(art("skills"), bearer(token))).status).toBe(401);

		// The thread's next turn resumes the stored session and continues the previous run (CHAT-03, DB-02).
		const next = o.dispatcher.runAgent(askRequest("t1", { scratchDir, resume: true }), recorder().hooks);
		const w2 = await FakeWorker.connect(o.api.url, "worker-2");
		const again = await w2.claim();
		expect(again.spec.resumeSession).toBe(true);
		expect(o.db.getRun(again.runId)?.continues_run_id).toBe(runId);
		expect(await (await fetch(`${o.api.url}${runArtifactPath(again.runId, "session")}`, bearer(again.token))).text()).toBe('{"type":"session"}\n');
		w2.relay(again.runId, { t: "done", result: { output: { answer: "again" }, sessionFile: "s", usage: USAGE, oomKills: 0 } });
		expect((await next).output).toEqual({ answer: "again" });
	});

	test("steering is queued (⏳) until the run registers and while the worker is away, then delivered (👀) (RUN-15)", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		const rec = recorder();
		const resultP = o.dispatcher.runAgent(askRequest("t1"), rec.hooks);
		// The handle comes at once; a steer before the host registered waits (⏳).
		expect(rec.handles).toHaveLength(1);
		const handle = rec.handles[0]!;
		let queued0 = 0;
		const early = handle.steer("zero", "ann", { onQueued: () => void queued0++ });
		expect(queued0).toBe(1);
		const w = await FakeWorker.connect(o.api.url, "worker-1");
		const { runId, token } = await w.claim();
		expect(w.inbox.some(m => m.t === "relay" && m.msg.t === "steer")).toBe(false);
		w.relay(runId, { t: "registered" });
		const sent0 = await w.down(m => m.t === "steer" && m.text.includes("zero"), "queued steer after registered");
		w.relay(runId, { t: "reply", id: sent0.msg.id, ok: true });
		expect(await early).toBe("delivered");

		// Host says not ready: resent after the next `registered`, still one ⏳.
		let queued = 0;
		const first = handle.steer("one", "ann", { onQueued: () => void queued++ });
		const sent1 = await w.down(m => m.t === "steer" && m.text.includes("one"), "first steer");
		w.relay(runId, { t: "reply", id: sent1.msg.id, ok: false, error: "Agent session is not ready" });
		await until(() => queued === 1, "⏳ for not ready");
		w.relay(runId, { t: "registered" });
		const resent = await w.down(m => m.t === "steer" && m.text.includes("one") && m.id !== sent1.msg.id, "steer resent after registered");
		w.relay(runId, { t: "reply", id: resent.msg.id, ok: true });
		expect(await first).toBe("delivered");
		expect(queued).toBe(1);

		// Worker away: ⏳ now, delivered after it re-announces its lease, with the scratch input announced first.
		w.close();
		await until(() => o.dispatcher.workers().length === 0, "disconnect");
		let queued2 = 0;
		const second = handle.steer("two", "ann", { onQueued: () => void queued2++, scratchInputs: ["b.txt"] });
		expect(queued2).toBe(1);
		const back = await FakeWorker.connect(o.api.url, "worker-1", { runId, token });
		const steer2 = await back.down(m => m.t === "steer" && m.text.includes("two"), "steer after reconnect");
		const order = back.inbox.map(m => (m.t === "relay" ? `relay:${m.msg.t}` : m.t));
		expect(order.indexOf("scratch-input")).toBeLessThan(order.indexOf("relay:steer"));
		expect(back.inbox.find(m => m.t === "scratch-input")).toEqual({ t: "scratch-input", runId, name: "b.txt" });
		back.relay(runId, { t: "reply", id: steer2.msg.id, ok: true }, 100);
		expect(await second).toBe("delivered");

		// A steer the run never reads ends as "ended".
		const third = handle.steer("three", "ann");
		back.relay(runId, { t: "failed", message: "boom", name: "Error" }, 101);
		expect(await third).toBe("ended");
		expect(resultP).rejects.toThrow("boom");
		await resultP.catch(() => {});
		expect(await handle.steer("late", "ann")).toBe("ended");
	});

	test("an orchestrator restart re-attaches: grace, outbox resent (RUN-06, RUN-07, RUN-09)", async () => {
		const s = await setup();
		const first = await s.start();
		await chatThread(first.db, "t1");
		const rec1 = recorder();
		void first.dispatcher.runAgent(askRequest("t1"), rec1.hooks).catch(() => {});
		const w = await FakeWorker.connect(first.api.url, "worker-1");
		const { runId, token } = await w.claim();
		w.relay(runId, { t: "registered" });
		await until(() => rec1.handles.length === 1, "register");
		// The worker drops; a steer goes to the outbox.
		w.close();
		await until(() => first.dispatcher.workers().length === 0, "disconnect");
		void rec1.handles[0]!.steer("while away", "ann");
		await first.stop();

		// A new process over the same database. The lease outlived its 600 ms only thanks to the grace period.
		await Bun.sleep(700);
		const second = await s.start({ graceMs: 3000 });
		const rec2 = recorder();
		const resultP = second.dispatcher.runAgent(askRequest("t1"), rec2.hooks);
		expect(rec2.handles).toHaveLength(1);
		expect(rec2.waiting).toBe(0);

		const back = await FakeWorker.connect(second.api.url, "worker-1", { runId, token });
		expect((await back.down(m => m.t === "steer", "outbox resent")).msg).toMatchObject({ text: "[Discord @ann]: while away" });
		// The worker continues its own numbering; the orchestrator remembers what it stored.
		back.relay(runId, { t: "done", result: { output: { answer: "done" }, sessionFile: "s", usage: USAGE, oomKills: 0 } }, 10);
		expect((await resultP).output).toEqual({ answer: "done" });
		expect(rec2.usage).toEqual([USAGE]);
	});

	test("a worker that stops heartbeating is lost; the attached caller gets RunLost (RUN-04)", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		const rec = recorder();
		const resultP = o.dispatcher.runAgent(askRequest("t1"), rec.hooks);
		const w = await FakeWorker.connect(o.api.url, "worker-1");
		const { runId } = await w.claim();
		w.relay(runId, { t: "registered" });
		w.relay(runId, { t: "progress", usage: USAGE, elapsedMs: 10 });
		await until(() => rec.handles.length === 1, "register");
		w.close();
		expect(resultP).rejects.toBeInstanceOf(RunLost);
		await resultP.catch(() => {});
		expect(o.db.getRun(runId)).toMatchObject({ state: "finished", outcome: "lost", loss_count: 1 });
		// Usage is still reported once (OBS-05).
		expect(rec.usage).toEqual([USAGE]);
		// A returning worker is told its lease is gone.
		const back = await FakeWorker.connect(o.api.url, "worker-1", { runId, token: "whatever" });
		await back.next(m => m.t === "lease-invalid", "lease-invalid");
	});

	test("a lost run with no caller attached keeps its outcome for the next caller", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		const detach = new AbortController();
		const first = o.dispatcher.runAgent(askRequest("t1"), recorder().hooks, detach.signal);
		const w = await FakeWorker.connect(o.api.url, "worker-1");
		const { runId } = await w.claim();
		w.relay(runId, { t: "registered" });
		detach.abort();
		expect(first).rejects.toThrow("detached");
		await first.catch(() => {});
		w.close();
		await until(() => o.db.getRun(runId)?.state === "finished", "lost");
		expect(o.dispatcher.hasUnfinishedRun("t1")).toBe(false);
		expect(o.dispatcher.runAgent(askRequest("t1"), recorder().hooks)).rejects.toBeInstanceOf(RunLost);
		await Bun.sleep(10);
		expect(o.db.getRun(runId)?.result).toBeNull();
	});

	test("caps keep runs in memory, not pending: maxChatSessions and maxConcurrentRuns (RUN-01, RUN-21)", async () => {
		const s = await setup();
		s.limits.value = { maxChatSessions: 1, maxConcurrentRuns: 4 };
		const o = await s.start();
		for (const t of ["t1", "t2", "t3"]) await chatThread(o.db, t);
		const a = recorder();
		const b = recorder();
		const pa = o.dispatcher.runAgent(askRequest("t1"), a.hooks);
		const pb = o.dispatcher.runAgent(askRequest("t2"), b.hooks);
		expect(o.dispatcher.counts().pending).toBe(1);
		expect(o.dispatcher.pendingRuns()).toBe(1);
		expect(o.dispatcher.hasUnfinishedRun("t2")).toBe(true);
		expect(b.waiting).toBe(1);
		// Attaching again detaches the first caller and never starts a second run (RUN-21).
		const attached = o.dispatcher.runAgent(askRequest("t1"), a.hooks);
		expect(pa).rejects.toThrow("detached");
		await pa.catch(() => {});
		expect(o.db.runsInState("pending")).toHaveLength(1);

		// Settings locked: nothing new becomes pending, even when a slot frees up.
		s.limits.value = undefined;
		const c = recorder();
		const pc = o.dispatcher.runAgent(askRequest("t3"), c.hooks);
		const w = await FakeWorker.connect(o.api.url, "worker-1");
		const { runId } = await w.claim();
		w.relay(runId, { t: "done", result: { output: { answer: "a" }, sessionFile: "s", usage: USAGE, oomKills: 0 } });
		expect((await attached).output).toEqual({ answer: "a" });
		expect(o.dispatcher.counts().pending).toBe(0);

		// Caps back: the oldest waiting run becomes pending; the other keeps waiting for the one run slot.
		s.limits.value = { maxChatSessions: 4, maxConcurrentRuns: 1 };
		await until(() => o.dispatcher.counts().pending === 1, "t2 pending");
		expect(o.db.runsInState("pending").map(r => r.thread_id)).toEqual(["t2"]);
		const w2 = await FakeWorker.connect(o.api.url, "worker-2");
		const assignB = await w2.claim();
		await Bun.sleep(50);
		expect(o.dispatcher.counts().pending).toBe(0);
		expect(c.waiting).toBe(1);

		// Aborting a run still waiting for a slot ends it at once; so does aborting one a worker claimed but never started (RUN-05).
		await c.handles[0]!.abort("user");
		const aborted = await pc;
		expect(aborted.aborted).toBe("user");
		expect(aborted.output).toBeUndefined();
		await b.handles[0]!.abort("user");
		expect((await pb).aborted).toBe("user");
		await w2.next(m => m.t === "lease-invalid" && m.runId === assignB.runId, "claimed run's worker told to stop");
		expect(o.db.getRun(assignB.runId)?.outcome).toBe("aborted");
	});

	test("abort: a pending run finishes at once; a running one is delivered on reconnect or finished at lease expiry (RUN-05)", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		await chatThread(o.db, "t2");
		const first = recorder();
		const p1 = o.dispatcher.runAgent(askRequest("t1"), first.hooks);
		const pendingId = o.db.runsInState("pending")[0]!.id;
		await first.handles[0]!.abort("user");
		expect((await p1).aborted).toBe("user");
		expect(o.db.getRun(pendingId)).toMatchObject({ state: "finished", outcome: "aborted" });

		const second = recorder();
		const p2 = o.dispatcher.runAgent(askRequest("t2"), second.hooks);
		const w = await FakeWorker.connect(o.api.url, "worker-1");
		const { runId, token } = await w.claim();
		w.relay(runId, { t: "registered" });
		await until(() => o.db.getRun(runId)?.state === "running", "running");
		w.close();
		await until(() => o.dispatcher.workers().length === 0, "disconnect");
		await second.handles[0]!.abort("time");
		// Delivered when the worker re-announces its lease…
		const back = await FakeWorker.connect(o.api.url, "worker-1", { runId, token });
		expect((await back.down(m => m.t === "abort", "abort after reconnect")).msg).toMatchObject({ reason: "time" });
		// …and if it never answers, the lease expiry finishes the run as aborted, not lost.
		back.close();
		expect((await p2).aborted).toBe("time");
		expect(o.db.getRun(runId)?.outcome).toBe("aborted");
	});

	test("abort of an assigned run whose worker is away: delivered on reconnect, or finished at lease expiry (RUN-05)", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		await chatThread(o.db, "t2");
		const back = recorder();
		const gone = recorder();
		const pBack = o.dispatcher.runAgent(askRequest("t1"), back.hooks);
		const pGone = o.dispatcher.runAgent(askRequest("t2"), gone.hooks);
		const w1 = await FakeWorker.connect(o.api.url, "worker-1");
		const a1 = await w1.claim();
		const w2 = await FakeWorker.connect(o.api.url, "worker-2");
		const a2 = await w2.claim();
		expect(o.db.getRun(a1.runId)?.state).toBe("assigned");
		w1.close();
		w2.close();
		await until(() => o.dispatcher.workers().length === 0, "both workers away");
		await back.handles[0]!.abort("user");
		await gone.handles[0]!.abort("user");
		// Nothing finishes while the abort cannot be delivered.
		expect(o.db.getRun(a1.runId)?.state).toBe("assigned");

		// The worker that comes back with its lease is told to stop the run; the run ends aborted.
		const again = await FakeWorker.connect(o.api.url, "worker-1", { runId: a1.runId, token: a1.token });
		await again.next(m => (m.t === "lease-invalid" && m.runId === a1.runId) || (m.t === "relay" && m.runId === a1.runId && m.msg.t === "abort"), "the abort on reconnect");
		expect((await pBack).aborted).toBe("user");
		expect(o.db.getRun(a1.runId)?.outcome).toBe("aborted");

		// The one that never returns is finished at lease expiry as aborted, not lost or pending again.
		expect((await pGone).aborted).toBe("user");
		expect(o.db.getRun(a2.runId)).toMatchObject({ state: "finished", outcome: "aborted" });
	});

	test("one claim per worker id, ever; an assignment lost in a reconnect goes back to pending at lease expiry (architecture §6, RUN-02)", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		await chatThread(o.db, "t2");
		void o.dispatcher.runAgent(askRequest("t1"), recorder().hooks).catch(() => {});
		void o.dispatcher.runAgent(askRequest("t2"), recorder().hooks).catch(() => {});
		const w = await FakeWorker.connect(o.api.url, "worker-1");
		const first = await w.claim();
		w.close();
		// The same worker id claiming again, on a new connection, gets nothing: neither its assignment nor the other run.
		const again = await FakeWorker.connect(o.api.url, "worker-1");
		again.send({ t: "claim" });
		await again.next(m => m.t === "nothing", "nothing");
		expect(again.inbox.some(m => m.t === "assign")).toBe(false);
		expect(o.dispatcher.pendingRuns()).toBe(1);
		// Nobody heartbeats the unstarted run: it is pending again and another worker takes it.
		await until(() => o.dispatcher.pendingRuns() === 2, "requeued at lease expiry");
		expect(o.db.getRun(first.runId)).toMatchObject({ state: "pending", worker_id: null });
		const other = await FakeWorker.connect(o.api.url, "worker-2");
		expect((await other.claim()).runId).toBe(first.runId);
	});

	test("one claim per address, also across a restart; a worker id stays with its first address (architecture §6)", async () => {
		const s = await setup();
		const first = await s.start({ bindWorkerAddresses: true, graceMs: 3000 });
		await chatThread(first.db, "t1");
		await chatThread(first.db, "t2");
		void first.dispatcher.runAgent(askRequest("t1"), recorder().hooks).catch(() => {});
		void first.dispatcher.runAgent(askRequest("t2"), recorder().hooks).catch(() => {});
		const w = await FakeWorker.connect(first.api.url, "worker-1");
		const claimed = await w.claim();
		expect(first.db.getRun(claimed.runId)?.worker_address).toBeTruthy();
		// Started: whether its lease is still live, lost or just finished, the address keeps counting as busy.
		w.relay(claimed.runId, { t: "registered" });
		await until(() => first.db.getRun(claimed.runId)?.state !== "assigned", "running");
		// Code inside that worker, with the worker token and a fresh id, gets nothing; the other run stays pending.
		const intruder = await FakeWorker.connect(first.api.url, "intruder-1");
		intruder.send({ t: "claim" });
		await intruder.next(m => m.t === "nothing", "nothing");
		expect(intruder.inbox.some(m => m.t === "assign")).toBe(false);
		expect(first.dispatcher.pendingRuns()).toBe(1);
		await first.stop();

		// After a restart the runs table still knows the address holds a run.
		const second = await s.start({ bindWorkerAddresses: true, graceMs: 3000 });
		await chatThread(second.db, "t3");
		void second.dispatcher.runAgent(askRequest("t3"), recorder().hooks).catch(() => {});
		const again = await FakeWorker.connect(second.api.url, "intruder-2");
		again.send({ t: "claim" });
		await again.next(m => m.t === "nothing", "nothing after the restart");
		expect(second.dispatcher.pendingRuns()).toBe(1);

		// A worker id first seen elsewhere is refused from this address.
		second.db.bindWorkerAddress("worker-elsewhere", "10.0.0.9");
		const taken = await FakeWorker.connect(second.api.url, "worker-elsewhere");
		await until(() => taken.isClosed, "the hello refused");
		expect(second.dispatcher.workers().some(c => c.id === "worker-elsewhere")).toBe(false);
		// Its own id is still welcome from the address it came from.
		await FakeWorker.connect(second.api.url, "worker-1");
		await until(() => second.dispatcher.workers().some(c => c.id === "worker-1"), "worker-1 connected");
	});

	test("invalid session keys fail clearly; oversized messages are dropped (RUN-16); unknown leases are refused", async () => {
		const s = await setup();
		const o = await s.start();
		expect(o.dispatcher.runAgent(askRequest("x", { session: "../escape" }), recorder().hooks)).rejects.toThrow("invalid session key");

		const w = await FakeWorker.connect(o.api.url, "worker-1");
		w.sendRaw(JSON.stringify({ t: "relay", runId: "r", seq: 1, msg: { t: "log", line: "x".repeat(5 * 1024 * 1024) } }));
		w.send({ t: "heartbeat", runId: "nope", token: "nope", phase: "running" });
		await w.next(m => m.t === "lease-invalid", "lease-invalid after the oversized message");
		expect(w.isClosed).toBe(false);
	});

	test("each token only on its own surface (SEC-14)", async () => {
		const s = await setup();
		const o = await s.start();
		await chatThread(o.db, "t1");
		await chatThread(o.db, "t2");
		void o.dispatcher.runAgent(askRequest("t1"), recorder().hooks).catch(() => {});
		void o.dispatcher.runAgent(askRequest("t2"), recorder().hooks).catch(() => {});
		const a = await (await FakeWorker.connect(o.api.url, "wa")).claim();
		const b = await (await FakeWorker.connect(o.api.url, "wb")).claim();
		const url = o.api.url;
		const status = async (path: string, token: string) => (await fetch(`${url}${path}`, bearer(token))).status;
		expect(await status("/internal/scale", SCALE_TOKEN)).toBe(200);
		expect(await status("/internal/scale", WORKER_TOKEN)).toBe(401);
		expect(await status("/internal/scale", a.token)).toBe(401);
		expect(await status(WORKER_WS_PATH, SCALE_TOKEN)).toBe(401);
		expect(await status(WORKER_WS_PATH, a.token)).toBe(401);
		expect(await status(runArtifactPath(a.runId, "skills"), a.token)).toBe(200);
		expect(await status(runArtifactPath(a.runId, "skills"), b.token)).toBe(401);
		expect(await status(runArtifactPath(a.runId, "skills"), WORKER_TOKEN)).toBe(401);
		expect(await status(runArtifactPath(a.runId, "skills"), SCALE_TOKEN)).toBe(401);
		expect(await openSocket(url, SCALE_TOKEN)).toBeUndefined();

		// The web token only on /internal/admin/*; no other token there.
		expect(await status("/internal/admin/state", WEB_TOKEN)).toBe(200);
		for (const token of [WORKER_TOKEN, SCALE_TOKEN, a.token]) expect(await status("/internal/admin/state", token)).toBe(401);
		expect(await status(WORKER_WS_PATH, WEB_TOKEN)).toBe(401);
		expect(await openSocket(url, WEB_TOKEN)).toBeUndefined();
		expect(await status("/internal/scale", WEB_TOKEN)).toBe(401);
		expect(await status(runArtifactPath(a.runId, "skills"), WEB_TOKEN)).toBe(401);
		expect(await openSocket(url, a.token)).toBeUndefined();
	});
});
