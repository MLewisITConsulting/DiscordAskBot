import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeDispatcher, type FakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import type { EngineDeps } from "../../src/orchestrator/engine/deps";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { parseConfig } from "../../src/shared/config";
import { createFakeDiscord, type FakeDiscord } from "./discord";

/**
 * Real `EngineDeps` over the fakes: fake Discord (with an ask-only channel), the fake dispatcher, an in-memory DB and
 * temporary state directories. `stop()` aborts the engine signal and cleans up.
 */
export interface EngineHarness {
	deps: EngineDeps;
	db: Db;
	discord: FakeDiscord;
	dispatcher: FakeDispatcher;
	/** Aborts `deps.signal` (engine stop). */
	controller: AbortController;
	askChannelId: string;
	stateDir: string;
	stop(): Promise<void>;
}

export const ALLOWED_USER = "u-allowed";

export async function createEngineHarness(opts: { config?: Record<string, unknown>; dispatcher?: FakeDispatcher } = {}): Promise<EngineHarness> {
	const discord = createFakeDiscord({ guildId: "g1" });
	const ask = discord.addChannel({ name: "ask", guildId: "g1" });
	const config = parseConfig({ discord: { guildId: "g1", allowedUserIds: [ALLOWED_USER], askChannelIds: [ask.id] }, ...opts.config });
	const stateDir = mkdtempSync(join(tmpdir(), "askbot-engine-"));
	const db = openDb(":memory:");
	const controller = new AbortController();
	const dispatcher = opts.dispatcher ?? createFakeDispatcher();
	const deps: EngineDeps = {
		config,
		db,
		discord,
		dispatcher,
		agentLog: await openAgentLog({ dir: join(stateDir, "logs", "agent") }),
		signal: controller.signal,
	};
	return {
		deps,
		db,
		discord,
		dispatcher,
		controller,
		askChannelId: ask.id,
		stateDir,
		async stop() {
			controller.abort();
			db.close();
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}
