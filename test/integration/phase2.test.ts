import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "../../src/orchestrator/discord/surface";
import { cannedOutput, createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import { ASK_CHANNEL_MISSING, parseSettings } from "../../src/shared/config";
import { createFakeDiscord, type Emitted, type FakeDiscord, type FakeMessage } from "../fakes/discord";

/**
 * Phase 2 exit (implementation.md §4) end to end through the real controller: vault settings, engine start and restart,
 * the bot and the ask chat, against the fake Discord surface and the fake dispatcher, which answers with a canned
 * `{answer}`. Only external surfaces are driven: Discord events, the vault and `controller.apply()`.
 */

const ASK = "ask-channel";
const ALLOWED = "u-allowed";

interface Harness {
	discord: FakeDiscord;
	dispatcher: FakeDispatcher;
	db: Db;
	vault: Vault;
	controller: Controller;
	/** A public user: not an allowed member. */
	bob: Actor;
	writeSettings(askChannelIds: string[]): void;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(): Promise<Harness> {
	const stateDir = mkdtempSync(join(tmpdir(), "askbot-phase2-"));
	const db = openDb(":memory:");
	const vault = await openVault(db);
	await vault.initialize("admin", "correct horse battery");
	const discord = createFakeDiscord({ guildId: "g1", channels: [{ id: ASK, name: "ask" }] });
	const dispatcher = createFakeDispatcher();
	const controller = createController({
		stateDir,
		ompDir: join(stateDir, "omp"),
		db,
		vault,
		agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
		dispatcher,
		connectDiscord: () => discord,
	});
	cleanups.push(async () => {
		await controller.stop();
		db.close();
		rmSync(stateDir, { recursive: true, force: true });
	});
	const h: Harness = {
		discord,
		dispatcher,
		db,
		vault,
		controller,
		bob: discord.actor("u-bob", { username: "bob" }),
		writeSettings(askChannelIds) {
			vault.writeSettings(
				parseSettings({
					config: { discord: { guildId: "g1", allowedUserIds: [ALLOWED], askChannelIds } },
					secrets: { discordToken: "discord-token" },
				}),
			);
		},
	};
	h.writeSettings([ASK]);
	await controller.apply();
	expect(controller.status()).toMatchObject({ phase: "running", error: undefined });
	return h;
}

/**
 * Waits for what the engine does in the background (runs settle off the event handler), so neither fake timers nor a
 * single promise covers it; the short sleep only yields to that work.
 */
async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(5);
	}
}

function answerText(e: Emitted): string {
	return e.responses.findLast(r => r.type === "reply" || r.type === "editReply" || r.type === "followUp")?.msg?.content ?? "";
}

/** `/ask` in the ask channel; returns the new thread's id. */
async function ask(h: Harness, prompt: string, actor: Actor): Promise<{ threadId: string; emitted: Emitted }> {
	const before = h.discord.messages(ASK).length;
	const emitted = await h.discord.emitCommand({ command: "ask", options: { prompt }, actor, channelId: ASK });
	const top = h.discord.messages(ASK)[before];
	if (!top) throw new Error(`no thread: ${answerText(emitted)}`);
	return { threadId: top.id, emitted };
}

const posted = (h: Harness, threadId: string, prefix: string): FakeMessage | undefined => h.discord.messages(threadId).find(m => m.content.startsWith(prefix));
const decode = (data: Uint8Array | string) => (typeof data === "string" ? data : new TextDecoder().decode(data));

describe("phase 2 exit", () => {
	test("/ask hello posts a thread with the canned answer.md, and /stop in that thread replies Nothing is running.", async () => {
		const h = await boot();
		expect(h.discord.commands("g1")?.map(c => c.name)).toEqual(["ask", "stop"]);
		expect(h.discord.nickname("g1")).toBe("AskBot");

		const { threadId, emitted } = await ask(h, "hello", h.bob);
		expect(emitted.responses[0]).toMatchObject({ type: "defer", ephemeral: true });
		expect(answerText(emitted)).toContain(`<#${threadId}>`);
		expect(h.discord.channels().find(c => c.id === threadId)).toMatchObject({ kind: "thread", parentId: ASK });
		await until(() => !!posted(h, threadId, "✅ **Done.**"), "the Done message");

		const answer = posted(h, threadId, "📄 **Answer attached:**")!;
		expect(answer.files.map(f => f.name)).toEqual(["answer.md"]);
		expect(cannedOutput(h.dispatcher.runs[0]!.req)).toEqual({ answer: decode(answer.files[0]!.data) });
		expect(posted(h, threadId, "✅ **Answering**")).toBeDefined();
		await h.discord.settled();
		expect(h.discord.message(threadId)?.content).toStartWith("✅ **bob** asked:\nhello");

		const before = h.discord.messages(threadId).length;
		const stopped = await h.discord.emitCommand({ command: "stop", actor: h.bob, channelId: threadId });
		expect(answerText(stopped)).toBe("Nothing is running.");
		await h.discord.settled();
		expect(h.discord.messages(threadId)).toHaveLength(before);
	});

	test("without an ask-only channel the engine stays unconfigured; adding one starts it (ENG-02)", async () => {
		const h = await boot();
		h.writeSettings([]);
		await h.controller.apply();
		expect(h.controller.status()).toMatchObject({ phase: "unconfigured", error: ASK_CHANNEL_MISSING });
		expect(h.discord.destroyed).toBe(true);
		h.writeSettings([ASK]);
		await h.controller.apply();
		expect(h.controller.status()).toMatchObject({ phase: "running", error: undefined });
	});

	test("an engine restart during a run re-attaches without aborting; the answer is posted once and the status message kept (RUN-14)", async () => {
		const h = await boot();
		h.dispatcher.once({ profile: "ask" }, { hold: true });
		const { threadId } = await ask(h, "slow one", h.bob);
		await until(() => h.dispatcher.runs[0]?.registered === true && !!posted(h, threadId, "🛠️ **Answering**"), "the live run");
		const status = posted(h, threadId, "🛠️ **Answering**")!;

		// A settings save restarts the engine (ENG-02); the run keeps going.
		await h.controller.apply();
		expect(h.controller.status().phase).toBe("running");
		expect(h.dispatcher.runs[0]!.aborted).toBeUndefined();
		await until(() => h.dispatcher.calls.some(c => c.attached), "the re-attach");
		h.dispatcher.runs[0]!.finish();
		await until(() => !!posted(h, threadId, "✅ **Done.**"), "the Done message");
		await h.discord.settled();
		expect(h.discord.messages(threadId).filter(m => m.content.startsWith("📄"))).toHaveLength(1);
		expect(h.discord.messages(threadId).filter(m => m.content.includes("**Answering**")).map(m => m.id)).toEqual([status.id]);
	});

	test("/stop during a run stops it; the thread shows Stopped. and ⏹️ (DSC-39, CHAT-05, DSC-15)", async () => {
		const h = await boot();
		h.dispatcher.once({ profile: "ask" }, { hold: true });
		const { threadId } = await ask(h, "stop me", h.bob);
		await until(() => h.dispatcher.runs[0]?.registered === true, "the live run");
		const stopped = await h.discord.emitCommand({ command: "stop", actor: h.bob, channelId: threadId });
		expect(answerText(stopped)).toBe("Stopping…");
		await until(() => !!posted(h, threadId, "⏹️ **Stopped.**"), "Stopped.");
		await h.discord.settled();
		expect(h.discord.message(threadId)?.content).toStartWith("⏹️");
	});
});
