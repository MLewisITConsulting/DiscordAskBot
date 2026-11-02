import { afterEach, describe, expect, test } from "bun:test";
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord-api-types/v10";
import { join } from "node:path";
import { attachBot, type BotHandle } from "../../src/orchestrator/discord/bot";
import type { Actor } from "../../src/orchestrator/discord/surface";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type AskChat, createAskChat } from "../../src/orchestrator/engine/chat";
import type { Emitted } from "../fakes/discord";
import { ALLOWED_USER, createEngineHarness, type EngineHarness } from "../fakes/engine";

interface Bot {
	h: EngineHarness;
	bot: BotHandle;
	askChat: AskChat;
	dispatcher: FakeDispatcher;
	allowed: Actor;
	starter: Actor;
	stranger: Actor;
}

let current: Bot | undefined;

afterEach(async () => {
	if (!current) return;
	current.bot.detach();
	await current.askChat.detach();
	await current.h.stop();
	current = undefined;
});

async function setup(opts: { config?: Record<string, unknown> } = {}): Promise<Bot> {
	const dispatcher = createFakeDispatcher();
	const h = await createEngineHarness({ ...opts, dispatcher });
	const askChat = createAskChat(h.deps, { scratchRoot: join(h.stateDir, "scratch"), ompDir: join(h.stateDir, "omp") });
	const bot = attachBot({ deps: h.deps, connection: h.discord, askChat });
	await h.discord.login("token");
	current = {
		h,
		bot,
		askChat,
		dispatcher,
		allowed: h.discord.actor(ALLOWED_USER, { username: "alice" }),
		starter: h.discord.actor("u-starter", { username: "sam" }),
		stranger: h.discord.actor("u-stranger", { username: "mallory" }),
	};
	return current;
}

/** The text of the interaction's final answer (reply or edited deferred reply). */
function answerText(e: Emitted): string {
	const last = e.responses.findLast(r => r.type === "reply" || r.type === "editReply" || r.type === "followUp");
	return last?.msg?.content ?? "";
}

/**
 * Waits for a condition the engine reaches in the background (runs settle off the event handler), so neither fake
 * timers nor a single promise covers it; the short sleep only yields to that work.
 */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** `/ask` in the ask channel by `actor`; returns the new thread's id. */
async function ask(b: Bot, prompt: string, actor: Actor): Promise<string> {
	const before = b.h.discord.messages(b.h.askChannelId).length;
	await b.h.discord.emitCommand({ command: "ask", options: { prompt }, actor, channelId: b.h.askChannelId });
	const top = b.h.discord.messages(b.h.askChannelId)[before];
	if (!top) throw new Error("no thread was started");
	return top.id;
}

const stop = (b: Bot, channelId: string, actor: Actor) => b.h.discord.emitCommand({ command: "stop", actor, channelId });

describe("ready (DSC-01, DSC-29)", () => {
	test("registers exactly /ask prompt [file file2 file3] and /stop, and sets the nickname", async () => {
		const b = await setup({ config: { agent: { name: "Quizzy" } } });
		await b.h.discord.triggerReady();
		const commands = b.h.discord.commands("g1") as RESTPostAPIChatInputApplicationCommandsJSONBody[];
		expect(commands.map(c => c.name)).toEqual(["ask", "stop"]);
		expect(commands[0]!.options?.map(o => [o.name, o.required])).toEqual([
			["prompt", true],
			["file", false],
			["file2", false],
			["file3", false],
		]);
		expect(commands[1]!.options ?? []).toEqual([]);
		expect(b.h.discord.nickname("g1")).toBe("Quizzy");
		expect(b.bot.nicknameWarning()).toBeUndefined();
	});

	test("without Change Nickname the bot warns and carries on; the warning clears once allowed", async () => {
		const b = await setup();
		b.h.discord.deny("ChangeNickname");
		await b.h.discord.triggerReady();
		expect(b.h.discord.commands("g1")?.length).toBe(2);
		expect(b.bot.nicknameWarning()).toContain("Change Nickname");
		b.h.discord.deny("ChangeNickname", false);
		await b.h.discord.triggerReady();
		expect(b.bot.nicknameWarning()).toBeUndefined();
	});
});

describe("/ask access (DSC-03, DSC-04)", () => {
	test("outside an ask-only channel and inside its threads, /ask is refused ephemerally and starts nothing", async () => {
		const b = await setup();
		const general = b.h.discord.addChannel({ name: "general", guildId: "g1" });
		const elsewhere = await b.h.discord.emitCommand({ command: "ask", options: { prompt: "hi" }, actor: b.allowed, channelId: general.id });
		expect(elsewhere.responses).toEqual([{ type: "reply", msg: { content: `\`/ask\` only works in <#${b.h.askChannelId}>.`, ephemeral: true }, ephemeral: true }]);

		const threadId = await ask(b, "first", b.stranger);
		await until(() => b.dispatcher.runs.length === 1, "the first run");
		const inThread = await b.h.discord.emitCommand({ command: "ask", options: { prompt: "again" }, actor: b.stranger, channelId: threadId });
		expect(inThread.responses[0]).toMatchObject({ type: "reply", ephemeral: true });
		expect(answerText(inThread)).toContain(`<#${b.h.askChannelId}>`);
		expect(b.h.db.allAskChats()).toHaveLength(1);
	});

	test("with no ask-only channel configured, /ask is refused as unconfigured", async () => {
		const b = await setup({ config: { discord: { guildId: "g1", allowedUserIds: [ALLOWED_USER] } } });
		const e = await b.h.discord.emitCommand({ command: "ask", options: { prompt: "hi" }, actor: b.allowed, channelId: "anywhere" });
		expect(answerText(e)).toBe("No ask-only channel is set up on this server.");
	});

	test("an unhandled error is answered ephemerally with Error: <message> (DSC-08)", async () => {
		const b = await setup();
		b.h.discord.deleteChannel(b.h.askChannelId);
		const e = await b.h.discord.emitCommand({ command: "ask", options: { prompt: "hi" }, actor: b.allowed, channelId: b.h.askChannelId });
		expect(e.responses.at(-1)).toMatchObject({ type: "followUp", ephemeral: true, msg: { content: expect.stringMatching(/^Error: Unknown Channel/) } });
	});
});

describe("/stop (DSC-39)", () => {
	test("outside an ask thread it is refused with Use inside an ask thread, for allowed members too", async () => {
		const b = await setup();
		const other = b.h.discord.addChannel({ name: "other-thread", kind: "thread", parentId: "general", guildId: "g1" });
		for (const channelId of [b.h.askChannelId, other.id]) {
			const e = await stop(b, channelId, b.allowed);
			expect(e.responses).toEqual([{ type: "reply", msg: { content: "Use inside an ask thread", ephemeral: true }, ephemeral: true }]);
		}
	});

	test("in an ask thread, a user who is neither the starter nor an allowed member is refused and nothing stops", async () => {
		const b = await setup();
		b.dispatcher.once({ profile: "ask" }, { hold: true });
		const threadId = await ask(b, "Keep going", b.starter);
		await until(() => b.dispatcher.runs[0]?.registered === true, "a registered run");
		const e = await stop(b, threadId, b.stranger);
		expect(e.responses[0]).toMatchObject({ type: "reply", ephemeral: true });
		expect(answerText(e)).toStartWith("Not authorized");
		expect(b.dispatcher.runs[0]!.aborted).toBeUndefined();
		b.dispatcher.runs[0]!.finish();
		await until(() => b.h.discord.messages(threadId).some(m => m.content.startsWith("✅ **Done.**")), "Done");
	});

	test("the thread starter stops the live run, which posts Stopped. (CHAT-05)", async () => {
		const b = await setup();
		b.dispatcher.once({ profile: "ask" }, { hold: true });
		const threadId = await ask(b, "Stop me", b.starter);
		await until(() => b.dispatcher.runs[0]?.registered === true, "a registered run");
		const e = await stop(b, threadId, b.starter);
		expect(e.responses).toEqual([{ type: "reply", msg: { content: "Stopping…" }, ephemeral: false }]);
		await until(() => b.h.discord.messages(threadId).some(m => m.content.startsWith("⏹️ **Stopped.**")), "Stopped.");
		expect(b.dispatcher.runs[0]!.aborted).toBe("user");
	});

	test("an allowed member may stop any ask thread; with nothing running the reply is Nothing is running.", async () => {
		const b = await setup();
		b.dispatcher.once({ profile: "ask" }, { hold: true });
		const threadId = await ask(b, "Stop me", b.starter);
		await until(() => b.dispatcher.runs[0]?.registered === true, "a registered run");
		expect(answerText(await stop(b, threadId, b.allowed))).toBe("Stopping…");
		await until(() => b.h.discord.messages(threadId).some(m => m.content.startsWith("⏹️ **Stopped.**")), "Stopped.");
		const before = b.h.discord.messages(threadId).length;
		expect(answerText(await stop(b, threadId, b.starter))).toBe("Nothing is running.");
		await b.h.discord.settled();
		expect(b.h.discord.messages(threadId)).toHaveLength(before);
		expect(b.dispatcher.runs).toHaveLength(1);
	});
});

describe("thread messages (DSC-06, DSC-08, DSC-24)", () => {
	test("steering is acknowledged with 👀 when delivered; strangers are ignored silently", async () => {
		const b = await setup();
		b.dispatcher.once({ profile: "ask" }, { hold: true });
		const threadId = await ask(b, "Steer me", b.starter);
		await until(() => b.dispatcher.runs[0]?.registered === true, "a registered run");
		const run = b.dispatcher.runs[0]!;

		const delivered = await b.h.discord.emitMessage({ channelId: threadId, content: "use tabs", actor: b.allowed });
		await until(() => b.h.discord.message(delivered.ref!.messageId)?.reactions.includes("👀") === true, "👀");
		expect(run.steers.map(s => s.text)).toEqual(["use tabs"]);

		const ignored = await b.h.discord.emitMessage({ channelId: threadId, content: "hi", actor: b.stranger });
		await b.h.discord.settled();
		expect(b.h.discord.message(ignored.ref!.messageId)?.reactions).toEqual([]);
		expect(run.steers).toHaveLength(1);
		run.finish();
	});

	test("a message for a run that cannot take it yet is marked ⏳, then 👀 once delivered (RUN-15)", async () => {
		const b = await setup();
		b.dispatcher.once({ profile: "ask" }, { hold: true, steerResult: "queued" });
		const threadId = await ask(b, "Queue me", b.starter);
		await until(() => b.dispatcher.runs[0]?.registered === true, "a registered run");
		const e = await b.h.discord.emitMessage({ channelId: threadId, content: "later", actor: b.starter });
		await until(() => b.h.discord.message(e.ref!.messageId)?.reactions.includes("⏳") === true, "⏳");
		b.dispatcher.runs[0]!.deliverSteers();
		await until(() => b.h.discord.message(e.ref!.messageId)?.reactions.join() === "👀", "👀 replacing ⏳");
		b.dispatcher.runs[0]!.finish();
	});

	test("bot authors, direct messages and messages outside threads are ignored by the bot itself (DSC-08)", async () => {
		const b = await setup();
		const threadId = await ask(b, "Hi", b.starter);
		await until(() => b.h.discord.messages(threadId).some(m => m.content.startsWith("✅ **Done.**")), "Done");
		await b.h.discord.settled();
		const before = b.h.discord.messages(threadId).length;
		// The starter's id, so only the bot-author rule can drop it.
		const otherBot = b.h.discord.actor(b.starter.userId, { username: "otherbot", isBot: true });
		// Delivered past the fake's adapter filter, so only the bot's own checks can drop them.
		await b.h.discord.emitMessage({ channelId: threadId, content: "more", actor: otherBot, unfiltered: true });
		await b.h.discord.emitMessage({ channelId: threadId, content: "more", actor: b.starter, unfiltered: true, guildId: null });
		await b.h.discord.emitMessage({ channelId: b.h.askChannelId, content: "more", actor: b.starter });
		await b.h.discord.settled();
		expect(b.dispatcher.runs).toHaveLength(1);
		// Only the two user messages were added to the thread; the bot posted nothing.
		expect(b.h.discord.messages(threadId)).toHaveLength(before + 2);
	});
});
