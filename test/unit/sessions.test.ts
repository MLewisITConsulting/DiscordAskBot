import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatSessionKey, isSessionKey, removeSessions, sessionDir as sessionsOf, sessionPath } from "../../src/orchestrator/store/sessions";
import { setLogSink } from "../../src/shared/log";

const root = mkdtempSync(join(tmpdir(), "askbot-sessions-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let stateDir: string;
let sessionDir: string;
let logs: Record<string, unknown>[];
let counter = 0;

beforeEach(() => {
	stateDir = join(root, `state${counter++}`);
	sessionDir = join(stateDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	logs = [];
	setLogSink(line => logs.push(JSON.parse(line)));
});
afterAll(() => setLogSink(undefined));

/** An omp-shaped session: `<key>.jsonl` plus a `<key>/` artifacts dir with a nested subagent transcript. */
function makeSession(key: string, dir = sessionDir): string {
	writeFileSync(join(dir, `${key}.jsonl`), "x".repeat(100));
	mkdirSync(join(dir, key, "sub"), { recursive: true });
	writeFileSync(join(dir, key, "sub", "agent.jsonl"), "y".repeat(50));
	return key;
}

const fileOf = (key: string, dir = sessionDir) => join(dir, `${key}.jsonl`);

describe("session keys", () => {
	test("sessionPath puts a key's file in the sessions dir and refuses unsafe keys", () => {
		expect(sessionsOf(stateDir)).toBe(sessionDir);
		expect(sessionPath(sessionDir, chatSessionKey("123"))).toBe(join(sessionDir, "chat-123.jsonl"));
		for (const bad of ["", "..", "../x", "a/b", "/abs", ".hidden", "a..b", "a\\b"]) {
			expect(isSessionKey(bad)).toBe(false);
			expect(() => sessionPath(sessionDir, bad)).toThrow("invalid session key");
		}
	});
});

describe("removeSessions", () => {
	test("removes the file and its artifacts dir and logs the bytes freed", async () => {
		const key = makeSession("a");
		const { kept } = await removeSessions(sessionDir, [key], { thread: "t1" });
		expect(kept).toEqual([]);
		expect(existsSync(fileOf(key))).toBe(false);
		expect(existsSync(join(sessionDir, "a"))).toBe(false);
		expect(logs.find(l => l.msg === "sessions removed")).toMatchObject({ sessions: ["a"], bytes: 150, thread: "t1" });
	});

	test("a missing session is not an error and does not stop the others", async () => {
		const real = makeSession("b");
		const { kept } = await removeSessions(sessionDir, ["gone", null, undefined, real], {});
		expect(kept).toEqual([]);
		expect(existsSync(fileOf(real))).toBe(false);
		expect(logs.filter(l => l.level === "warn")).toEqual([]);
	});

	test("never deletes outside the sessions dir (ENG-05)", async () => {
		makeSession("outside", stateDir);
		const evilDir = join(stateDir, "sessions-evil");
		mkdirSync(evilDir);
		makeSession("y", evilDir);
		const absolute = fileOf("outside", stateDir);

		const { kept } = await removeSessions(sessionDir, ["../outside", absolute, "../sessions-evil/y", "..", "."], {});
		expect(kept).toEqual([]);
		for (const path of [fileOf("outside", stateDir), join(stateDir, "outside"), fileOf("y", evilDir), join(evilDir, "y"), sessionDir]) {
			expect(existsSync(path)).toBe(true);
		}
		expect(logs.filter(l => l.msg === "session outside session dir skipped")).toHaveLength(5);
	});
});
