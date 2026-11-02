import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeDispatcher } from "../../src/orchestrator/dispatch/fake";
import { type Controller, createController } from "../../src/orchestrator/engine/controller";
import { openAgentLog } from "../../src/orchestrator/store/agentlog";
import { type Db, openDb } from "../../src/orchestrator/store/db";
import { openVault, type Vault } from "../../src/orchestrator/store/vault";
import { ASK_CHANNEL_MISSING, parseSettings, type Settings } from "../../src/shared/config";
import { createFakeDiscord, type FakeDiscord } from "../fakes/discord";

const PASSWORD = "correct horse battery";

interface Harness {
	stateDir: string;
	db: Db;
	vault: Vault;
	discords: FakeDiscord[];
	applied: number[];
	controller: Controller;
	settings(extra?: Record<string, unknown>, discordToken?: string): Settings;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(opts: { loginError?: string; initialize?: boolean } = {}): Promise<Harness> {
	const stateDir = mkdtempSync(join(tmpdir(), "askbot-controller-"));
	const db = openDb(":memory:");
	const vault = await openVault(db);
	if (opts.initialize !== false) await vault.initialize("admin", PASSWORD);
	const agentLog = await openAgentLog({ dir: join(stateDir, "logs", "agent"), maxBytes: 1024 ** 3 });
	const discords: FakeDiscord[] = [];
	const applied: number[] = [];
	const controller = createController({
		stateDir,
		ompDir: join(stateDir, "omp"),
		db,
		vault,
		agentLog,
		dispatcher: createFakeDispatcher(),
		applyLogCap: gib => applied.push(gib),
		connectDiscord: () => {
			const discord = createFakeDiscord({ loginError: opts.loginError });
			discords.push(discord);
			return discord;
		},
	});
	cleanups.push(async () => {
		await controller.stop();
		db.close();
		rmSync(stateDir, { recursive: true, force: true });
	});
	return {
		stateDir,
		db,
		vault,
		discords,
		applied,
		controller,
		settings: (extra = {}, discordToken = "discord-token") =>
			parseSettings({
				config: { discord: { guildId: "g", allowedUserIds: ["u"], askChannelIds: ["ask"] }, ...extra },
				secrets: { discordToken },
			}),
	};
}

test("apply passes Settings → Logs to applyLogCap before the engine starts, even if the engine then fails", async () => {
	const h = await harness({ loginError: "An invalid token was provided." });
	h.vault.writeSettings(h.settings({ logs: { maxGiB: 1.5 } }));
	await h.controller.apply();
	expect(h.applied).toEqual([1.5]);
	expect(h.controller.status()).toMatchObject({ phase: "error", error: expect.stringContaining("An invalid token was provided.") });
	expect(h.controller.snapshot()).toBeUndefined();
	// A failed login leaves nothing connected.
	expect(h.discords[0]!.destroyed).toBe(true);
});

test("apply chooses setup, locked and unconfigured from the vault (ENG-02)", async () => {
	const fresh = await harness({ initialize: false });
	expect(fresh.controller.status().phase).toBe("setup");
	await fresh.controller.apply();
	expect(fresh.controller.status().phase).toBe("setup");

	const h = await harness();
	await h.controller.apply();
	expect(h.controller.status().phase).toBe("unconfigured");

	const locked = createController({
		stateDir: h.stateDir,
		ompDir: join(h.stateDir, "omp"),
		db: h.db,
		vault: await openVault(h.db),
		agentLog: await openAgentLog({ dir: join(h.stateDir, "logs", "agent2"), maxBytes: 1024 ** 3 }),
		dispatcher: createFakeDispatcher(),
	});
	expect(locked.status().phase).toBe("locked");
	await locked.apply();
	expect(locked.status().phase).toBe("locked");
	await locked.stop();
});

test("settings without an ask-only channel save, but the engine stays unconfigured until one is chosen (ENG-02, WEB-20)", async () => {
	const h = await harness();
	const settings = h.settings();
	settings.config.discord.askChannelIds = [];
	h.vault.writeSettings(settings);
	await h.controller.apply();
	expect(h.controller.status()).toMatchObject({ phase: "unconfigured", error: ASK_CHANNEL_MISSING });
	expect(h.discords).toHaveLength(0);

	h.vault.writeSettings(h.settings());
	await h.controller.apply();
	expect(h.controller.status()).toMatchObject({ phase: "running", error: undefined });
});

test("a running engine creates the state dirs, logs in to Discord and reports a snapshot (ENG-03)", async () => {
	const h = await harness();
	h.vault.writeSettings(h.settings());
	await h.controller.apply();
	expect(h.controller.status()).toMatchObject({ phase: "running", error: undefined });
	for (const dir of ["sessions", "scratch", "omp-agent"]) expect(existsSync(join(h.stateDir, dir))).toBe(true);
	expect(h.discords).toHaveLength(1);
	expect(h.discords[0]!.loggedIn).toBe(true);
	expect(h.discords[0]!.token).toBe("discord-token");
	const snapshot = h.controller.snapshot()!;
	expect(snapshot.discord).toMatchObject({ ready: true, nicknameWarning: undefined });
	expect(snapshot.discordQueue).toMatchObject({ length: 0 });
});

test("overlapping applies are serialised: each restart stops the previous engine first", async () => {
	const h = await harness();
	h.vault.writeSettings(h.settings());
	await Promise.all([h.controller.apply(), h.controller.apply(), h.controller.apply()]);
	expect(h.controller.status().phase).toBe("running");
	expect(h.discords).toHaveLength(3);
	expect(h.discords.map(d => d.destroyed)).toEqual([true, true, false]);
});

test("stop stays in stopping and no later apply starts the engine again (ENG-04)", async () => {
	const h = await harness();
	h.vault.writeSettings(h.settings());
	await h.controller.apply();
	await h.controller.stop();
	expect(h.controller.status().phase).toBe("stopping");
	expect(h.discords[0]!.destroyed).toBe(true);
	await h.controller.apply();
	expect(h.controller.status().phase).toBe("stopping");
	expect(h.discords).toHaveLength(1);
});
