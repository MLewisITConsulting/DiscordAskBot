import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { resetSettingsForTest, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgProvidersWebSearchTimeoutSeconds } from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import { emptyOmpConfig, initRunSettings, listSettings, OmpConfigError, parseOmpConfig, parseSettingValue, sessionSettings } from "../../src/shared/ompconfig";

describe("omp settings", () => {
	test("values are parsed with omp's types and validated", () => {
		expect(parseSettingValue("compaction.enabled", "off")).toBe(false);
		expect(parseSettingValue("mcp.startupTimeoutMs", "5000")).toBe(5000);
		expect(parseSettingValue("find.enabled", "on")).toBe("on");
		expect(() => parseSettingValue("find.enabled", "sometimes")).toThrow(OmpConfigError);
		expect(() => parseSettingValue("mcp.startupTimeoutMs", "soon")).toThrow("mcp.startupTimeoutMs");
		expect(() => parseSettingValue("no.such.setting", "1")).toThrow('Unknown omp setting "no.such.setting"');
	});

	test("pinned settings cannot be overridden and are applied last (AGT-20)", () => {
		expect(() => parseSettingValue("tools.approvalMode", "always-ask")).toThrow("managed by AskBot");
		expect(() => parseOmpConfig({ settings: { "async.enabled": true } })).toThrow("managed by AskBot");
		const merged = sessionSettings({ settings: { "compaction.enabled": false, "find.enabled": "on", "ask.timeout": 30 } });
		expect(merged).toMatchObject({
			"compaction.enabled": false,
			"find.enabled": "on",
			"tools.approvalMode": "yolo",
			"async.enabled": false,
			"ask.timeout": 0,
			skillful: true,
			"task.maxRecursionDepth": 1,
		});
		const pinned = listSettings()
			.filter(s => s.locked)
			.map(s => s.id)
			.sort();
		expect(pinned).toEqual(["ask.timeout", "async.enabled", "skillful", "task.maxRecursionDepth", "tools.approvalMode"]);
	});

	test("whole-config validation catches bad settings", () => {
		expect(() => parseOmpConfig({ settings: { "find.enabled": "sometimes" } })).toThrow(OmpConfigError);
		expect(parseOmpConfig({ settings: { "compaction.enabled": true } })).toEqual({ settings: { "compaction.enabled": true } });
		expect(parseOmpConfig({})).toEqual(emptyOmpConfig());
	});
});

describe("initRunSettings", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "askbot-omp-"));
	});
	afterEach(async () => {
		resetSettingsForTest();
		await rm(dir, { recursive: true, force: true });
	});

	test("web_search can read omp's process-global settings", async () => {
		await initRunSettings(emptyOmpConfig(), dir);
		const authStorage = await discoverAuthStorage(dir, { cwd: dir });
		try {
			const modelRegistry = new ModelRegistry(authStorage, join(dir, "models.yml"));
			const result = await runSearchQuery({ query: "x", model: "none/none" }, { authStorage, modelRegistry });
			expect(result.content[0]?.text).toBe('Error: No web search model matches selector "none/none".');
		} finally {
			authStorage.close();
		}
	});

	test("admin overrides are what the global settings return", async () => {
		const returned = await initRunSettings({ settings: { "providers.webSearchTimeoutSeconds": 7 } }, dir);
		expect(cfgProvidersWebSearchTimeoutSeconds.get(returned)).toBe(7);
		expect(cfgProvidersWebSearchTimeoutSeconds.get(settings)).toBe(7);
	});

	test("a second call in the same process throws instead of keeping the first run's settings", async () => {
		await initRunSettings(emptyOmpConfig(), dir);
		await expect(initRunSettings(emptyOmpConfig(), dir)).rejects.toThrow("already initialized");
	});
});
