import { describe, expect, test } from "bun:test";
import { RunDetached, type RunHandle, type RunHooks, type RunRequest } from "../../src/orchestrator/dispatch/dispatcher";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import type { RunUsage } from "../../src/shared/transcript";

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
	threadId: "t1",
	profile: "ask",
	prompt: "p",
	thinking: "high",
	limits: { minutes: 1, costUsd: 1 },
	session: "chat-t1",
	resume: false,
	scratchDir: "/tmp/askbot-fake-scratch",
	...over,
});

function hooks() {
	const usage: RunUsage[] = [];
	const handles: RunHandle[] = [];
	const h: RunHooks = { register: handle => void handles.push(handle), onUsage: u => void usage.push(u) };
	return { h, usage, handles };
}

describe("createFakeDispatcher", () => {
	test("yields a canned answer", async () => {
		const d = createFakeDispatcher();
		expect((await d.runAgent(req(), hooks().h)).output).toHaveProperty("answer");
	});

	test("detaching rejects with RunDetached, the run goes on, and the next caller gets the result and the usage once", async () => {
		const d = createFakeDispatcher();
		d.script({ threadId: "t1" }, { hold: true });
		const first = hooks();
		const controller = new AbortController();
		const p1 = d.runAgent(req(), first.h, controller.signal);
		controller.abort();
		expect(p1).rejects.toBeInstanceOf(RunDetached);
		await p1.catch(() => {});
		expect(d.hasUnfinishedRun("t1")).toBe(true);
		d.run("t1")!.finish();
		expect(d.hasUnfinishedRun("t1")).toBe(false);

		const second = hooks();
		const result = await d.runAgent(req(), second.h);
		expect(result.output).toHaveProperty("answer");
		expect(first.usage).toEqual([]);
		expect(second.usage).toHaveLength(1);
		expect(d.runs).toHaveLength(1);
		expect(d.run("t1")).toBeUndefined();
	});

	test("abort is one-shot: the first reason wins", async () => {
		const d = createFakeDispatcher();
		d.script({ threadId: "t1" }, { hold: true });
		const { h, handles } = hooks();
		const running = d.runAgent(req(), h);
		await handles[0]!.abort("time");
		await handles[0]!.abort("user");
		expect((await running).aborted).toBe("time");
		expect(await handles[0]!.steer("x", "a")).toBe("ended");
	});

	test("counts pending runs while they wait for a worker", async () => {
		const d = createFakeDispatcher();
		const gate = Promise.withResolvers<void>();
		d.once({ threadId: "t1" }, { pending: gate.promise });
		const waiting: string[] = [];
		const running = d.runAgent(req(), { ...hooks().h, onWaitingForWorker: () => void waiting.push("w") });
		expect(d.counts()).toMatchObject({ pending: 1, running: 0 });
		expect(d.counts().oldestPendingMs).not.toBeNull();
		expect(waiting).toEqual(["w"]);
		gate.resolve();
		await running;
		expect(d.counts()).toEqual({ pending: 0, running: 0, oldestPendingMs: null });
	});
});
