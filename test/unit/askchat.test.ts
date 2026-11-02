import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Actor, InAttachment } from "../../src/orchestrator/discord/surface";
import { createFakeDispatcher, type FakeDispatcher, type FakeRunScript } from "../../src/orchestrator/dispatch/fake";
import { OOM_WARNING } from "../../src/orchestrator/discord/render";
import { ANSWER_TRUNCATED, type AskChat, createAskChat, deliveryMessages, NOTHING_RUNNING, SWEPT_NOTE, truncateUtf8 } from "../../src/orchestrator/engine/chat";
import { runUiKey } from "../../src/orchestrator/store/runUi";
import { MAX_INPUT_BYTES, scratchPaths } from "../../src/orchestrator/store/scratch";
import { latestLoadout } from "../../src/orchestrator/store/stats";
import type { FakeMessage } from "../fakes/discord";
import { ALLOWED_USER, createEngineHarness, type EngineHarness } from "../fakes/engine";

interface Ask {
	h: EngineHarness;
	chat: AskChat;
	dispatcher: FakeDispatcher;
	askChannel: string;
	scratchRoot: string;
	/** The admin's skills and agents (AGT-24). */
	ompDir: string;
	allowed: Actor;
	stranger: Actor;
	/** Downloadable attachment bodies by URL. */
	files: Map<string, string>;
	/** Swaps the AskChat the fake Discord delivers to (a restarted engine). */
	use(chat: AskChat): void;
}

let current: Ask | undefined;

afterEach(async () => {
	if (!current) return;
	await current.chat.detach();
	await current.h.stop();
	current = undefined;
});

async function setup(opts: { limits?: Record<string, unknown> } = {}): Promise<Ask> {
	const dispatcher = createFakeDispatcher();
	const h = await createEngineHarness({ dispatcher, config: opts.limits ? { limits: opts.limits } : {} });
	const files = new Map<string, string>();
	const scratchRoot = join(h.stateDir, "scratch");
	const ompDir = join(h.stateDir, "omp");
	const make = () =>
		createAskChat(h.deps, {
			scratchRoot,
			ompDir,
			fetch: async url => (files.has(url) ? new Response(files.get(url)) : new Response("missing", { status: 404 })),
		});
	let chat = make();
	h.discord.onEvent(async event => {
		if (event.type === "command" && event.command === "ask") await chat.command(event);
		if (event.type === "message") await chat.message(event);
	});
	await h.discord.login("token");
	current = {
		h,
		chat,
		dispatcher,
		askChannel: h.askChannelId,
		scratchRoot,
		ompDir,
		allowed: h.discord.actor(ALLOWED_USER, { username: "alice" }),
		stranger: h.discord.actor("u-stranger", { username: "mallory" }),
		files,
		use(next) {
			chat = next;
			if (current) current.chat = next;
		},
	};
	return current;
}

/**
 * Waits for a condition the chat reaches in the background (runs, downloads and the Discord queue settle off the event
 * handler), so neither fake timers nor a single promise covers it; the short sleep only yields to that work.
 */
async function until(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

/** Runs `/ask` and returns the new thread's id (the top message's id) and the command's responses. */
async function ask(a: Ask, prompt: string, opts: { actor?: Actor; attachments?: InAttachment[] } = {}) {
	const before = a.h.discord.messages(a.askChannel).length;
	const emitted = await a.h.discord.emitCommand({
		command: "ask",
		options: { prompt },
		attachments: opts.attachments ?? [],
		actor: opts.actor ?? a.allowed,
		channelId: a.askChannel,
	});
	const top = a.h.discord.messages(a.askChannel)[before];
	return { threadId: top?.id, emitted };
}

const thread = (a: Ask, threadId: string): FakeMessage[] => a.h.discord.messages(threadId);
const posted = (a: Ask, threadId: string, prefix: string) => thread(a, threadId).find(m => m.content.startsWith(prefix));
const done = (a: Ask, threadId: string) => until(() => !!posted(a, threadId, "✅ **Done.**"), "the Done message");
const topIcon = (a: Ask, threadId: string) => a.h.discord.message(threadId)?.content.split(" ")[0];
const decode = (data: Uint8Array | string) => (typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data));

describe("answer delivery helpers (CHAT-10)", () => {
	test("truncation cuts at a UTF-8 character boundary and appends the note", () => {
		const note = "!";
		// "é" is 2 bytes: a cut at byte 7 would split the fourth one.
		const cut = truncateUtf8("é".repeat(10), 8, note);
		expect(cut.length).toBeLessThanOrEqual(8);
		expect(decode(cut)).toBe("ééé!");
		// "😀" is 4 bytes: 10 - 1 = 9 lands inside the third one.
		expect(decode(truncateUtf8("😀".repeat(5), 10, note))).toBe("😀😀!");
		for (let limit = 1; limit < 40; limit++) {
			const bytes = truncateUtf8("a€😀é".repeat(10), limit, note);
			expect(bytes.length).toBeLessThanOrEqual(Math.max(limit, 1));
			expect(() => decode(bytes)).not.toThrow();
		}
		expect(decode(truncateUtf8("short", 100, note))).toBe("short");
	});

	test("the answer is attached as answer.md, files follow in batches, oversize files are listed by name", async () => {
		const a = await setup();
		const dir = join(a.scratchRoot, "helpers");
		const file = async (name: string, size: number) => {
			await Bun.write(join(dir, name), "x".repeat(size));
			return { name, path: join(dir, name), size };
		};
		const files = [await file("a.csv", 800), await file("answer.md", 300), await file("big.json", 5000)];
		const messages = await deliveryMessages("€".repeat(500), files, 1000);
		expect(messages.map(m => m.content)).toEqual([
			"📄 **Answer attached:** `answer.md` and 2 generated files below",
			"📎 `a.csv`",
			"📎 `answer.md`",
			"⚠️ Too large to attach (over 0 MiB): big.json",
		]);
		expect(messages.flatMap(m => m.files ?? []).map(f => f.name)).toEqual(["answer.md", "a.csv", "answer-1.md"]);
		const answer = messages[0]!.files![0]!.data as Uint8Array;
		expect(answer.length).toBeLessThanOrEqual(1000);
		expect(decode(answer).endsWith(ANSWER_TRUNCATED)).toBe(true);
		// No answer (stopped or failed run): only the files.
		expect((await deliveryMessages(undefined, [files[0]!], 1000)).map(m => m.content)).toEqual(["📎 `a.csv`"]);
	});
});

describe("/ask (CHAT-07, CHAT-08)", () => {
	test("starts a one-day thread, saves the command's attachments and runs the ask profile", async () => {
		const a = await setup();
		a.files.set("u1", "alpha");
		a.files.set("u2", "beta");
		a.dispatcher.once({ profile: "ask" }, { output: { answer: "# Hi" } });
		const { threadId, emitted } = await ask(a, "What is in these?", {
			actor: a.stranger,
			attachments: [
				{ name: "a.txt", url: "u1", size: 5 },
				{ name: "../we ird?.txt", url: "u2", size: 4 },
				{ name: "big.bin", url: "u3", size: MAX_INPUT_BYTES + 1 },
				{ name: "fourth.txt", url: "u1", size: 5 },
			],
		});
		expect(threadId).toBeDefined();
		const id = threadId!;
		expect(a.h.discord.channels().find(c => c.id === id)?.kind).toBe("thread");
		expect(emitted.responses.at(-1)?.msg?.content).toContain(`<#${id}>`);
		await done(a, id);

		const paths = scratchPaths(a.scratchRoot, id);
		expect(await Bun.file(join(paths.inputs, "a.txt")).text()).toBe("alpha");
		expect(await Bun.file(join(paths.inputs, "we ird_.txt")).text()).toBe("beta");
		const warning = posted(a, id, "⚠️ **Couldn't use these files:**")!;
		expect(warning.content).toContain("`big.bin`: larger than 25 MiB");
		expect(warning.content).toContain("`fourth.txt`: more than 3 files at once");

		const run = a.dispatcher.runs[0]!;
		expect(run.req).toMatchObject({
			threadId: id,
			profile: "ask",
			session: `chat-${id}`,
			resume: false,
			scratchDir: paths.root,
			limits: { minutes: 20, costUsd: a.h.deps.config.limits.maxCostUsdPerTurn },
		});
		expect(run.req.prompt).toContain("What is in these?");
		expect(run.req.prompt).toContain("- inputs/a.txt\n- inputs/we ird_.txt");
		expect(a.h.db.getAskChat(id)?.owner_id).toBe("u-stranger");
	});

	test("delivers answer.md and the produced files, then Done with ✅ on the top message", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { output: { answer: "Here you go" }, outputFiles: { "report.csv": "a,b\n1,2" } });
		const { threadId } = await ask(a, "Make a CSV");
		await done(a, threadId!);
		const answer = posted(a, threadId!, "📄 **Answer attached:**")!;
		expect(answer.content).toBe("📄 **Answer attached:** `answer.md` and 1 generated file below");
		expect(decode(answer.files[0]!.data)).toBe("Here you go");
		const file = posted(a, threadId!, "📎")!;
		expect(file.files.map(f => [f.name, decode(f.data)])).toEqual([["report.csv", "a,b\n1,2"]]);
		expect(topIcon(a, threadId!)).toBe("✅");
		expect(a.h.db.getAskChat(threadId!)?.session_file).toBe(`chat-${threadId}`);
		expect(a.h.db.kvGet(runUiKey(threadId!))).toBeUndefined();
	});

	test("produced files are delivered when the run fails or stops at a limit (CHAT-05, CHAT-10)", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { error: "model exploded", outputFiles: { "partial.txt": "half" } });
		const failed = (await ask(a, "Try")).threadId!;
		await until(() => !!posted(a, failed, "❌ **Failed:**"), "the failure message");
		expect(posted(a, failed, "❌ **Failed:**")!.content).toContain("model exploded");
		expect(posted(a, failed, "📎")!.files.map(f => f.name)).toEqual(["partial.txt"]);
		expect(topIcon(a, failed)).toBe("❌");

		a.dispatcher.once({ profile: "ask" }, { aborted: "time", outputFiles: { "draft.md": "wip" } });
		const limited = (await ask(a, "Long one")).threadId!;
		await until(() => !!posted(a, limited, "⚠️ **Stopped at the 20 minute time limit**"), "the limit message");
		expect(posted(a, limited, "📎")!.files.map(f => f.name)).toEqual(["draft.md"]);
		expect(posted(a, limited, "📄")).toBeUndefined();
		await until(() => topIcon(a, limited) === "⚠️", "⚠️ top icon");
	});

	test("the prompt names `task` only when a valid agent is installed; skills are always mentioned (AGT-13, AGT-31)", async () => {
		const a = await setup({ limits: { maxChatSessions: 5 } });
		const agent = (name: string, tools: string) =>
			Bun.write(join(a.ompDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Looks things up\ntools: ${tools}\n---\nYou research.\n`);
		const promptOf = async (question: string) => {
			const id = (await ask(a, question)).threadId!;
			await done(a, id);
			return a.dispatcher.runs.find(r => r.req.threadId === id)!.req.prompt;
		};

		const none = await promptOf("No agents");
		expect(none).toContain("skill://<name>");
		expect(none).not.toContain("`task`");

		// An agent the worker would skip (AGT-25: tools outside the allowlist) does not count.
		await agent("shell", "bash");
		expect(await promptOf("Invalid agent only")).not.toContain("`task`");

		await agent("researcher", "web_search");
		const valid = await promptOf("A valid agent");
		expect(valid).toContain("`task`");
		expect(valid).toContain("skill://<name>");
	});
});

describe("admission (CHAT-04, DSC-06)", () => {
	test("capacity: maxChatSessions active chats refuse a new /ask", async () => {
		const a = await setup({ limits: { maxChatSessions: 1 } });
		a.dispatcher.script({ profile: "ask" }, { hold: true });
		const first = await ask(a, "One");
		await until(() => a.dispatcher.runs.length === 1, "first run");
		const second = await ask(a, "Two", { actor: a.h.discord.actor("u-other", { username: "bob" }) });
		expect(second.emitted.responses.at(-1)?.msg?.content).toBe("Chat capacity reached; try again shortly.");
		expect(second.threadId).toBeUndefined();
		a.dispatcher.run(first.threadId!)!.finish();
		await done(a, first.threadId!);
	});

	test("a non-allowed user has one live run across threads; allowed members are not limited", async () => {
		const a = await setup({ limits: { maxChatSessions: 5 } });
		a.dispatcher.script({ profile: "ask" }, { hold: true });
		const mine = (await ask(a, "First", { actor: a.stranger })).threadId!;
		await until(() => a.dispatcher.hasUnfinishedRun(mine), "the stranger's run");
		const refused = await ask(a, "Second", { actor: a.stranger });
		expect(refused.emitted.responses.at(-1)?.msg?.content).toBe(`You already have a request running in <#${mine}>; wait for it to finish.`);
		await ask(a, "Mine", { actor: a.allowed });
		await ask(a, "Mine too", { actor: a.allowed });
		await until(() => a.dispatcher.runs.length === 3, "the allowed member's runs");
	});

	test("a follow-up while the run is still starting is refused", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { hold: true, registerAt: null });
		const id = (await ask(a, "Slow start")).threadId!;
		await until(() => a.dispatcher.runs.length === 1, "run");
		await a.h.discord.emitMessage({ channelId: id, content: "hello?", actor: a.allowed });
		await until(() => !!posted(a, id, "Still starting the previous request"), "refusal");
		expect(a.dispatcher.runs).toHaveLength(1);
	});
});

describe("follow-ups (CHAT-03, DSC-06)", () => {
	test("steer the live run (👀), ignore strangers, then resume the session in a new run", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { hold: true });
		const id = (await ask(a, "Start")).threadId!;
		await until(() => a.dispatcher.runs[0]?.registered === true, "registered run");
		const run = a.dispatcher.runs[0]!;

		a.files.set("n1", "notes");
		const steer = await a.h.discord.emitMessage({ channelId: id, content: "also this", actor: a.allowed, attachments: [{ name: "notes.txt", url: "n1", size: 5 }] });
		await until(() => a.h.discord.message(steer.ref!.messageId)?.reactions.includes("👀") === true, "👀");
		expect(run.steers).toHaveLength(1);
		expect(run.steers[0]).toMatchObject({ from: "alice", scratchInputs: ["notes.txt"] });
		expect(run.steers[0]!.text).toContain("also this\n\n## Attached files\n- inputs/notes.txt");

		const ignored = await a.h.discord.emitMessage({ channelId: id, content: "let me in", actor: a.stranger });
		await a.h.discord.settled();
		expect(a.h.discord.message(ignored.ref!.messageId)?.reactions).toEqual([]);
		expect(run.steers).toHaveLength(1);

		run.finish();
		await done(a, id);
		await a.h.discord.emitMessage({ channelId: id, content: "and now?", actor: a.allowed });
		await until(() => a.dispatcher.runs.length === 2, "the resumed run");
		const next = a.dispatcher.runs[1]!;
		expect(next.req).toMatchObject({ threadId: id, session: `chat-${id}`, resume: true });
		expect(next.req.prompt).toContain("and now?");
		expect(next.req.prompt).not.toContain(SWEPT_NOTE);
	});

	test("a non-allowed starter may follow up in their own thread; a stranger's attachment is ignored (DSC-06)", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { hold: true });
		const id = (await ask(a, "Start", { actor: a.stranger })).threadId!;
		await until(() => a.dispatcher.runs[0]?.registered === true, "registered run");
		const run = a.dispatcher.runs[0]!;

		const intruder = a.h.discord.actor("u-intruder", { username: "intruder" });
		a.files.set("x1", "payload");
		const ignored = await a.h.discord.emitMessage({ channelId: id, content: "", actor: intruder, attachments: [{ name: "x.txt", url: "x1", size: 7 }] });
		await a.h.discord.settled();
		expect(a.h.discord.message(ignored.ref!.messageId)?.reactions).toEqual([]);
		expect(run.steers).toEqual([]);

		const own = await a.h.discord.emitMessage({ channelId: id, content: "one more thing", actor: a.stranger });
		await until(() => a.h.discord.message(own.ref!.messageId)?.reactions.includes("👀") === true, "👀 for the starter");
		expect(run.steers).toHaveLength(1);
		expect(run.steers[0]!.text).toContain("one more thing");
	});

	test("a steer the run ends before reading gets ⏳, then Not delivered", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { hold: true, steerResult: "queued" });
		const id = (await ask(a, "Start")).threadId!;
		await until(() => a.dispatcher.runs[0]?.registered === true, "registered run");
		const e = await a.h.discord.emitMessage({ channelId: id, content: "wait", actor: a.allowed });
		await until(() => a.h.discord.message(e.ref!.messageId)?.reactions.includes("⏳") === true, "⏳");
		a.dispatcher.runs[0]!.finish();
		await until(() => thread(a, id).some(m => m.replyTo === e.ref!.messageId && m.content.startsWith("Not delivered")), "Not delivered");
		expect(a.h.discord.message(e.ref!.messageId)?.reactions).toEqual([]);
	});
});

describe("/stop (DSC-39, CHAT-05)", () => {
	test("stops the live run, which posts Stopped; with nothing running it changes nothing", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { hold: true });
		const id = (await ask(a, "Stop me")).threadId!;
		await until(() => a.dispatcher.runs[0]?.registered === true, "registered run");
		expect(await a.chat.stop(id, "@alice")).toBe("Stopping…");
		// A double click finds the same run stopping (NFR-05).
		expect(await a.chat.stop(id, "@alice")).toBe("Stopping…");
		await until(() => !!posted(a, id, "⏹️ **Stopped.**"), "Stopped message");
		expect(a.dispatcher.runs[0]!.aborted).toBe("user");
		expect(topIcon(a, id)).toBe("⏹️");
		const before = thread(a, id).length;
		expect(await a.chat.stop(id, "@alice")).toBe(NOTHING_RUNNING);
		await a.h.discord.settled();
		expect(thread(a, id)).toHaveLength(before);
		expect(a.dispatcher.runs).toHaveLength(1);
	});

	test("a stop before the run registered aborts it as soon as it does", async () => {
		const a = await setup();
		const gate = Promise.withResolvers<void>();
		a.dispatcher.once({ profile: "ask" }, { registerAt: 1, steps: [{ until: gate.promise }], hold: true });
		const id = (await ask(a, "Slow")).threadId!;
		await until(() => a.dispatcher.runs.length === 1, "run");
		expect(await a.chat.stop(id, "@alice")).toBe("Stopping…");
		gate.resolve();
		await until(() => !!posted(a, id, "⏹️ **Stopped.**"), "Stopped message");
		expect(a.dispatcher.runs[0]!.aborted).toBe("user");
	});

	test("ownerOf names the starter of ask threads only", async () => {
		const a = await setup();
		const id = (await ask(a, "Hi", { actor: a.stranger })).threadId!;
		await done(a, id);
		expect(a.chat.ownerOf(id)).toBe("u-stranger");
		expect(a.chat.ownerOf(a.askChannel)).toBeUndefined();
	});
});

describe("usage (OBS-05, OBS-06, AGT-19)", () => {
	const rows = (a: Ask) =>
		a.h.db.raw
			.query<{ thread_id: string; channel_id: string; user_id: string; outcome: string; oom_kills: number; cost_usd: number }, []>(
				"SELECT thread_id, channel_id, user_id, outcome, oom_kills, cost_usd FROM agent_runs ORDER BY id",
			)
			.all();

	test("every turn records its usage with the ask channel, the user and how it ended", async () => {
		const a = await setup({ limits: { maxChatSessions: 5 } });
		a.dispatcher.once({ profile: "ask" }, { usage: { costUsd: 0.5 } });
		const finished = (await ask(a, "One")).threadId!;
		await done(a, finished);
		a.dispatcher.once({ profile: "ask" }, { aborted: "cost" });
		const limited = (await ask(a, "Two")).threadId!;
		await until(() => !!posted(a, limited, "⚠️ **Stopped at the $15 cost limit**"), "limit message");
		a.dispatcher.once({ profile: "ask" }, { error: "boom" });
		const failed = (await ask(a, "Three", { actor: a.stranger })).threadId!;
		await until(() => !!posted(a, failed, "❌ **Failed:**"), "failure");
		await until(() => rows(a).length === 3, "three usage rows");
		expect(rows(a)).toEqual([
			{ thread_id: finished, channel_id: a.askChannel, user_id: ALLOWED_USER, outcome: "finished", oom_kills: 0, cost_usd: 0.5 },
			expect.objectContaining({ thread_id: limited, outcome: "limit" }),
			expect.objectContaining({ thread_id: failed, user_id: "u-stranger", outcome: "failed" }),
		]);
	});

	test("an out-of-memory turn says so in its answer message and records the count", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { oomKills: 2, output: { answer: "Partial" } });
		const id = (await ask(a, "Big")).threadId!;
		await done(a, id);
		expect(posted(a, id, "📄")!.content).toBe(`📄 **Answer attached:** \`answer.md\`\n${OOM_WARNING}`);
		expect(rows(a)[0]).toMatchObject({ outcome: "finished", oom_kills: 2 });
	});

	test("the loadout is stored for the status page (AGT-27)", async () => {
		const a = await setup();
		const loadout = { capturedAt: "2026-01-01T00:00:00.000Z", profile: "ask" as const, tools: ["web_search", "yield"], skills: [], agents: [] };
		// The worker reports the loadout once the session exists (AGT-27); the fake dispatcher has no such step.
		const runAgent = a.dispatcher.runAgent.bind(a.dispatcher);
		a.dispatcher.runAgent = (req, hooks, signal) => {
			hooks.onLoadout?.(loadout);
			return runAgent(req, hooks, signal);
		};
		const id = (await ask(a, "Hi")).threadId!;
		await done(a, id);
		expect(latestLoadout(a.h.db)).toEqual(loadout);
	});
});

describe("idle sweep (CHAT-06, CHAT-11)", () => {
	test("removes an idle chat's scratch directory, keeps the session, and tells the next run", async () => {
		const a = await setup();
		a.files.set("f", "data");
		const id = (await ask(a, "Look", { attachments: [{ name: "f.txt", url: "f", size: 4 }] })).threadId!;
		await done(a, id);
		const root = scratchPaths(a.scratchRoot, id).root;
		expect(existsSync(join(root, "inputs", "f.txt"))).toBe(true);

		await a.chat.sweepIdle();
		expect(existsSync(root)).toBe(true);
		a.h.db.updateAskChat(id, { last_active_at: "2000-01-01T00:00:00.000Z" });
		await a.chat.sweepIdle();
		expect(existsSync(root)).toBe(false);
		expect(a.h.db.getAskChat(id)).toMatchObject({ scratch_dir: null, session_file: `chat-${id}` });

		await a.h.discord.emitMessage({ channelId: id, content: "again", actor: a.allowed });
		await until(() => a.dispatcher.runs.length === 2, "the follow-up run");
		expect(a.dispatcher.runs[1]!.req.prompt).toContain(`Note: ${SWEPT_NOTE}`);
		expect(a.dispatcher.runs[1]!.req.resume).toBe(true);
		expect(existsSync(join(root, "inputs"))).toBe(true);
	});

	test("never removes a chat with a live run", async () => {
		const a = await setup();
		a.dispatcher.once({ profile: "ask" }, { hold: true });
		const id = (await ask(a, "Busy")).threadId!;
		await until(() => a.dispatcher.runs.length === 1, "run");
		a.h.db.updateAskChat(id, { last_active_at: "2000-01-01T00:00:00.000Z" });
		await a.chat.sweepIdle();
		expect(existsSync(scratchPaths(a.scratchRoot, id).root)).toBe(true);
	});
});

describe("restart (RUN-14)", () => {
	test("a re-attached chat keeps editing the same status message", async () => {
		const a = await setup();
		const gate = Promise.withResolvers<void>();
		const steps: FakeRunScript["steps"] = [{ progress: { tool: "web_search", intent: "Searching" } }, { until: gate.promise }];
		a.dispatcher.once({ profile: "ask" }, { steps, output: { answer: "Found it" } });
		const id = (await ask(a, "Find it")).threadId!;
		await until(() => !!posted(a, id, "🛠️ **Answering**") && a.dispatcher.runs[0]?.registered === true, "the status message");
		await a.h.discord.settled();
		const status = posted(a, id, "🛠️ **Answering**")!;
		await until(() => a.h.db.kvGet(runUiKey(id))?.includes(status.id) === true, "stored run UI state");

		// Engine restart: the old instance detaches (the run keeps going), a new one re-attaches.
		await a.chat.detach();
		expect(a.dispatcher.hasUnfinishedRun(id)).toBe(true);
		const restarted = createAskChat(a.h.deps, { scratchRoot: a.scratchRoot, ompDir: a.ompDir });
		a.use(restarted);
		restarted.start();
		await until(() => restarted.active.has(id), "re-attached chat");
		gate.resolve();
		await done(a, id);

		const statuses = thread(a, id).filter(m => m.content.includes("**Answering**"));
		expect(statuses.map(m => m.id)).toEqual([status.id]);
		expect(statuses[0]!.content).toStartWith("✅ **Answering**");
		expect(a.dispatcher.calls.filter(c => c.attached)).toHaveLength(1);
		expect(a.h.db.kvGet(runUiKey(id))).toBeUndefined();
	});

	test("a deleted status message is posted anew and its id stored", async () => {
		const a = await setup();
		const gate = Promise.withResolvers<void>();
		a.dispatcher.once({ profile: "ask" }, { steps: [{ until: gate.promise }] });
		const id = (await ask(a, "Hold on")).threadId!;
		// The run must exist before the engine stops, or the turn never started.
		await until(() => a.dispatcher.runs[0]?.registered === true && !!posted(a, id, "🛠️ **Answering**"), "status message and run");
		const status = posted(a, id, "🛠️ **Answering**")!;
		await a.chat.detach();
		a.h.discord.deleteMessage({ channelId: id, messageId: status.id });
		const restarted = createAskChat(a.h.deps, { scratchRoot: a.scratchRoot, ompDir: a.ompDir });
		a.use(restarted);
		restarted.start();
		await until(() => {
			const stored = a.h.db.kvGet(runUiKey(id));
			return !!stored && !stored.includes(status.id);
		}, "the new status id stored");
		gate.resolve();
		await done(a, id);
		expect(thread(a, id).filter(m => m.content.includes("**Answering**"))).toHaveLength(1);
	});
});
