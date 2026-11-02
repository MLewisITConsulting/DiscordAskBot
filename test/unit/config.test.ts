import { describe, expect, test } from "bun:test";
import { ASK_CHANNEL_MISSING, ConfigError, hasAskChannel, isAllowedMember, isAskChannel, parseConfig, parseSecrets } from "../../src/shared/config";

const minimal = {
	discord: { guildId: "1", allowedUserIds: ["42"] },
};

describe("parseConfig", () => {
	test("applies defaults (requirements §9)", () => {
		const config = parseConfig(minimal);
		expect(config.discord.allowedRoleIds).toEqual([]);
		expect(config.discord.askChannelIds).toEqual([]);
		expect(config.agent.name).toBe("AskBot");
		expect(config.models).toEqual({ thinking: "high" });
		expect(config.limits).toEqual({ maxChatSessions: 2, maxCostUsdPerTurn: 15, chatIdleMinutes: 30 });
		expect(config.workers).toEqual({ reattachGraceSeconds: 90 });
		expect(config.logs).toEqual({ maxGiB: 5 });
		expect(config.omp).toEqual({ autoUpdate: false });
	});

	test("errors use `Invalid config: <path>: <message>`", () => {
		expect(() => parseConfig({ ...minimal, limits: { maxChatSessions: 0 } })).toThrow(/^Invalid config: limits\.maxChatSessions: /);
	});

	test("unknown sections are dropped", () => {
		const config = parseConfig({ ...minimal, github: { appId: 7 }, labels: {} });
		expect(config).not.toHaveProperty("github");
		expect(config).not.toHaveProperty("labels");
	});

	test("agent.name is 1-32 characters", () => {
		expect(parseConfig({ ...minimal, agent: { name: "x".repeat(32) } }).agent.name).toHaveLength(32);
		expect(() => parseConfig({ ...minimal, agent: { name: "x".repeat(33) } })).toThrow(/agent\.name:/);
		expect(() => parseConfig({ ...minimal, agent: { name: "" } })).toThrow(/agent\.name:/);
	});

	test("models.ask is optional; models.thinking accepts only the listed levels", () => {
		expect(parseConfig({ ...minimal, models: { thinking: "xhigh", ask: "m" } }).models.ask).toBe("m");
		expect(() => parseConfig({ ...minimal, models: { thinking: "ultra" } })).toThrow(/models\.thinking:/);
	});

	test("limits are positive", () => {
		expect(parseConfig({ ...minimal, limits: { maxCostUsdPerTurn: 0.5, chatIdleMinutes: 1.5 } }).limits).toMatchObject({ maxCostUsdPerTurn: 0.5, chatIdleMinutes: 1.5 });
		expect(() => parseConfig({ ...minimal, limits: { maxChatSessions: 1.5 } })).toThrow(/limits\.maxChatSessions:/);
		expect(() => parseConfig({ ...minimal, limits: { maxCostUsdPerTurn: 0 } })).toThrow(/limits\.maxCostUsdPerTurn:/);
		expect(() => parseConfig({ ...minimal, limits: { chatIdleMinutes: -1 } })).toThrow(/limits\.chatIdleMinutes:/);
	});

	test("workers settings", () => {
		expect(parseConfig({ ...minimal, workers: { maxConcurrentRuns: 50 } }).workers.maxConcurrentRuns).toBe(50);
		expect(() => parseConfig({ ...minimal, workers: { maxConcurrentRuns: 0 } })).toThrow(/workers\.maxConcurrentRuns:/);
		expect(() => parseConfig({ ...minimal, workers: { reattachGraceSeconds: 1.5 } })).toThrow(/workers\.reattachGraceSeconds:/);
	});

	test("logs.maxGiB rejects less than 0.1", () => {
		expect(parseConfig({ ...minimal, logs: { maxGiB: 0.1 } }).logs.maxGiB).toBe(0.1);
		expect(() => parseConfig({ ...minimal, logs: { maxGiB: 0.05 } })).toThrow(/logs\.maxGiB:/);
	});

	test("omp.autoUpdate must be a boolean", () => {
		expect(parseConfig({ ...minimal, omp: { autoUpdate: true } }).omp.autoUpdate).toBe(true);
		expect(() => parseConfig({ ...minimal, omp: { autoUpdate: "yes" } })).toThrow(/omp\.autoUpdate:/);
	});

	test("rejects empty allow-lists (DSC-02)", () => {
		const raw = { ...minimal, discord: { ...minimal.discord, allowedUserIds: [], allowedRoleIds: [] } };
		expect(() => parseConfig(raw)).toThrow(ConfigError);
		expect(parseConfig({ discord: { guildId: "1", allowedRoleIds: ["r"] } }).discord.allowedRoleIds).toEqual(["r"]);
	});

	test("rejects a duplicate ask-only channel (DSC-03)", () => {
		expect(parseConfig({ ...minimal, discord: { ...minimal.discord, askChannelIds: ["200", "201"] } }).discord.askChannelIds).toEqual(["200", "201"]);
		const dup = { ...minimal, discord: { ...minimal.discord, askChannelIds: ["200", "200"] } };
		expect(() => parseConfig(dup)).toThrow(/discord\.askChannelIds\.1: duplicate channel 200/);
	});
});

describe("config helpers", () => {
	test("the engine needs an ask-only channel (ENG-02)", () => {
		expect(hasAskChannel(parseConfig(minimal))).toBe(false);
		expect(hasAskChannel(parseConfig({ discord: { ...minimal.discord, askChannelIds: ["200"] } }))).toBe(true);
		expect(ASK_CHANNEL_MISSING).toBe("Add an ask-only channel in Settings (Discord) to start the engine.");
	});

	test("isAllowedMember: a listed user or any listed role", () => {
		const config = parseConfig({ discord: { guildId: "1", allowedUserIds: ["42"], allowedRoleIds: ["r1"] } });
		expect(isAllowedMember(config, "42", [])).toBe(true);
		expect(isAllowedMember(config, "7", ["r0", "r1"])).toBe(true);
		expect(isAllowedMember(config, "7", ["r0"])).toBe(false);
	});

	test("isAskChannel matches only listed channels", () => {
		const config = parseConfig({ discord: { ...minimal.discord, askChannelIds: ["200"] } });
		expect(isAskChannel(config, "200")).toBe(true);
		expect(isAskChannel(config, "201")).toBe(false);
		expect(isAskChannel(config, null)).toBe(false);
	});
});

describe("parseSecrets", () => {
	test("rejects missing discordToken with a secrets path", () => {
		expect(() => parseSecrets({})).toThrow(/^Invalid config: secrets\.discordToken:/);
	});

	test("accepts valid secrets; providerKeys defaults to {}", () => {
		expect(parseSecrets({ discordToken: "t" })).toEqual({ discordToken: "t", providerKeys: {} });
		expect(parseSecrets({ discordToken: "t", providerKeys: { openai: "k" } }).providerKeys).toEqual({ openai: "k" });
	});
});
