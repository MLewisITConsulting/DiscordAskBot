import { describe, expect, test } from "bun:test";
import { startProgress } from "../../src/orchestrator/discord/progress";
import { CHAT_ICONS, setTopIcon } from "../../src/orchestrator/discord/topMessage";
import type { RunUiState } from "../../src/orchestrator/dispatch/dispatcher";
import { createFakeDiscord } from "../fakes/discord";

function setup() {
	const fake = createFakeDiscord({ channels: [{ id: "thread-1", name: "t" }] });
	return { fake, messages: () => fake.messages("thread-1") };
}

test("one status message shows the final state and ignores activity after finishing (DSC-10)", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Answering", "Preparing the workspace…");
	expect(messages()[0]!.content).toContain("↳ Preparing the workspace…");
	expect(progress.ref()).toEqual({ channelId: "thread-1", messageId: messages()[0]!.id });
	await progress.finish("done");
	expect(messages()[0]!.content).toStartWith("✅ **Answering**");
	progress.activity("late", 9);
	await progress.finish("failed");
	await fake.settled();
	expect(messages()[0]!.content).toStartWith("✅ **Answering**");
	expect(messages()).toHaveLength(1);
});

test("activity right after a change waits for the throttle; phases show at once (DSC-11)", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Answering", "Starting…");
	progress.activity("Reading (`read_file`)", 0.5);
	await fake.settled();
	expect(messages()[0]!.edits).toBe(0);
	progress.phase("Waiting for a worker…");
	await fake.settled();
	expect(messages()[0]!.edits).toBe(1);
	expect(messages()[0]!.content).toContain("$0.50\n↳ Waiting for a worker…");
	await progress.finish("cancelled");
});

test("progress edits of one message coalesce in the queue: only the latest state is written (DSC-32)", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Answering", "Starting…");
	fake.pause();
	progress.phase("one");
	progress.phase("two");
	expect(fake.queueStats().length).toBe(1);
	fake.resume();
	await fake.settled();
	expect(messages()[0]!.edits).toBe(1);
	expect(messages()[0]!.content).toContain("↳ two");
	await progress.finish("done");
});

test("stop ends updates without writing a final state (engine detach)", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Answering", "Thinking…");
	progress.stop();
	progress.phase("late");
	await progress.finish("done");
	await fake.settled();
	expect(messages()[0]!.edits).toBe(0);
	expect(messages()[0]!.content).toStartWith("🛠️ **Answering** · working");
});

test("progress edits that fail never fail the run (DSC-11)", async () => {
	const { fake, messages } = setup();
	const progress = await startProgress(fake, "thread-1", "Answering", "Starting…");
	fake.deleteMessage({ channelId: "thread-1", messageId: messages()[0]!.id });
	progress.phase("next");
	await progress.finish("done");
});

describe("thread top message icon (DSC-15)", () => {
	async function threadWithTop(content: string, byUser = false) {
		const fake = createFakeDiscord({ channels: [{ id: "ask", name: "ask" }] });
		const top = byUser ? (await fake.emitMessage({ channelId: "ask", content, actor: fake.actor("someone") })).ref! : await fake.send("ask", { content });
		const threadId = await fake.startThread(top, { name: "t", autoArchiveMinutes: 1440 });
		return { fake, threadId, top: () => fake.message(top.messageId)!.content };
	}

	test("replaces only the leading icon", async () => {
		const { fake, threadId, top } = await threadWithTop("💬 **alice** asked:\nWhat is 2+2?");
		await setTopIcon(fake, threadId, CHAT_ICONS.done);
		expect(top()).toBe("✅ **alice** asked:\nWhat is 2+2?");
	});

	test("threads without a top message, or one the bot can't edit, are left alone without failing", async () => {
		const missing = createFakeDiscord();
		await setTopIcon(missing, "no-such-thread", "✅");
		const { fake, threadId, top } = await threadWithTop("📥 someone else's message", true);
		await setTopIcon(fake, threadId, "✅");
		expect(top()).toBe("📥 someone else's message");
	});
});

describe("restore after a restart (RUN-14)", () => {
	test("stores its state, and a restored progress edits the same status message", async () => {
		const { fake, messages } = setup();
		let stored: RunUiState | undefined;
		const first = await startProgress(fake, "thread-1", "Answering", "Starting…", { persist: s => (stored = s) });
		first.phase("Searching", 0.25);
		await fake.settled();
		first.stop();
		expect(stored).toMatchObject({
			statusMessage: { channelId: "thread-1", messageId: messages()[0]!.id },
			progress: { state: "running", activity: "Searching", costUsd: 0.25 },
		});

		const second = await startProgress(fake, "thread-1", "Answering", "Starting…", { restore: stored, persist: s => (stored = s) });
		await fake.settled();
		expect(messages()).toHaveLength(1);
		expect(messages()[0]!.content).toContain("$0.25");
		expect(messages()[0]!.content).toContain("↳ Searching");
		await second.finish("done");
		await fake.settled();
		expect(messages()).toHaveLength(1);
		expect(messages()[0]!.content).toStartWith("✅ **Answering**");
	});

	test("a deleted message is posted anew and its new id stored", async () => {
		const { fake, messages } = setup();
		let stored: RunUiState | undefined;
		const first = await startProgress(fake, "thread-1", "Answering", "Starting…", { persist: s => (stored = s) });
		first.phase("Searching");
		await fake.settled();
		first.stop();
		fake.deleteMessage({ channelId: "thread-1", messageId: messages()[0]!.id });

		await startProgress(fake, "thread-1", "Answering", "Starting…", { restore: stored, persist: s => (stored = s) });
		await fake.settled();
		expect(messages()).toHaveLength(1);
		expect(stored?.statusMessage?.messageId).toBe(messages()[0]!.id);
		expect(messages()[0]!.content).toContain("↳ Searching");
	});
});
