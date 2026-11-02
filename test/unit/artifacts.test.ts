import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactHandler, MAX_SESSION_BYTES, STATE_FREE_FLOOR_BYTES } from "../../src/orchestrator/dispatch/artifacts";
import { claimNextRun } from "../../src/orchestrator/dispatch/leases";
import { type Db, type NewRun, openDb, type RunRow } from "../../src/orchestrator/store/db";
import { sessionDir, sessionPath } from "../../src/orchestrator/store/sessions";
import { ARTIFACTS, runArtifactPath } from "../../src/shared/wire";

/**
 * The run artifact uploads against a lease (security review F2, F8): one upload at a time per run and artifact, the
 * session cap, the state volume's free-space floor, and the lease checked again before anything is kept.
 */

/** A pending run of a new ask thread `threadId` (runs belong to an ask chat, DB-02). */
function pending(db: Db, threadId: string, extra: Omit<NewRun, "threadId"> = {}): RunRow {
	db.insertAskChat(threadId, "c1", "u1");
	return db.insertRun({ threadId, ...extra });
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});

async function setup(over: { freeFloorBytes?: number } = {}) {
	const stateDir = await mkdtemp(join(tmpdir(), "askbot-artifacts-"));
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
	const db = openDb(":memory:");
	const handler = createArtifactHandler({
		db,
		stateDir,
		skills: async () => ({ hash: "h", tar: new Uint8Array() }),
		freeFloorBytes: over.freeFloorBytes ?? STATE_FREE_FLOOR_BYTES,
	});
	return { stateDir, db, handler };
}

/** A claimed run with a session and a scratch directory, and its lease token. */
function claimed(db: Db, stateDir: string): { row: RunRow; token: string } {
	pending(db, "t1", { sessionKey: "s1", scratchDir: join(stateDir, "scratch", "t1") });
	const row = claimNextRun(db, "w1", 60_000)!;
	return { row, token: row.leaseToken };
}

function put(runId: string, artifact: string, token: string, body: BodyInit): Request {
	return new Request(`http://orchestrator${runArtifactPath(runId, artifact)}`, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } });
}

/** A request body that stays open until `end` is called. */
function heldBody(first: string) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start: c => {
			controller = c;
			c.enqueue(new TextEncoder().encode(first));
		},
	});
	return {
		stream,
		end: () => controller.close(),
	};
}

describe("run artifact uploads (F2, F8)", () => {
	test("one upload at a time per run and artifact; other artifacts are not blocked", async () => {
		const { stateDir, db, handler } = await setup();
		const { row, token } = claimed(db, stateDir);
		const held = heldBody('{"type":"session"}\n');
		const first = handler.handle(put(row.id, ARTIFACTS.session, token, held.stream));
		const second = await handler.handle(put(row.id, ARTIFACTS.session, token, "other"));
		expect(second.status).toBe(503);
		expect(second.headers.get("retry-after")).toBe("1");
		expect((await handler.handle(put(row.id, ARTIFACTS.scratchOutput("a.txt"), token, "a"))).status).toBe(204);
		held.end();
		expect((await first).status).toBe(204);
		// The slot is free again.
		expect((await handler.handle(put(row.id, ARTIFACTS.session, token, "again\n"))).status).toBe(204);
		expect(await readFile(sessionPath(sessionDir(stateDir), "s1"), "utf8")).toBe("again\n");
	});

	test(`a session over ${MAX_SESSION_BYTES / 1024 ** 2} MiB is refused and nothing is kept`, async () => {
		const { stateDir, db, handler } = await setup();
		const { row, token } = claimed(db, stateDir);
		const mib = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull: c => {
				if (sent++ > MAX_SESSION_BYTES / mib.byteLength) c.close();
				else c.enqueue(mib);
			},
		});
		expect((await handler.handle(put(row.id, ARTIFACTS.session, token, body))).status).toBe(413);
		expect(existsSync(sessionPath(sessionDir(stateDir), "s1"))).toBe(false);
	});

	test("uploads are refused while the state volume is below its free-space floor", async () => {
		const { stateDir, db, handler } = await setup({ freeFloorBytes: Number.MAX_SAFE_INTEGER });
		const { row, token } = claimed(db, stateDir);
		for (const artifact of [ARTIFACTS.session, ARTIFACTS.scratchOutput("a.txt")]) {
			expect((await handler.handle(put(row.id, artifact, token, "x"))).status).toBe(507);
		}
		expect(existsSync(sessionPath(sessionDir(stateDir), "s1"))).toBe(false);
	});

	test("a session or output upload that outlives the lease keeps nothing (F8)", async () => {
		const { stateDir, db, handler } = await setup();
		const { row, token } = claimed(db, stateDir);
		const session = heldBody('{"type":"poisoned"}\n');
		const output = heldBody("late");
		const sessionPut = handler.handle(put(row.id, ARTIFACTS.session, token, session.stream));
		const outputPut = handler.handle(put(row.id, ARTIFACTS.scratchOutput("late.txt"), token, output.stream));
		db.transitionRun(row.id, ["assigned"], "finished", { outcome: "succeeded" });
		session.end();
		output.end();
		expect((await sessionPut).status).toBe(401);
		expect((await outputPut).status).toBe(401);
		expect(existsSync(sessionPath(sessionDir(stateDir), "s1"))).toBe(false);
		expect(existsSync(join(stateDir, "scratch", "t1", "outputs", "late.txt"))).toBe(false);
	});
});
