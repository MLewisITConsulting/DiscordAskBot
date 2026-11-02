import { describe, expect, test } from "bun:test";
import { healthLimits } from "../../src/orchestrator/api/health";
import { type Config, parseConfig } from "../../src/shared/config";

function config(maxChatSessions: number, maxConcurrentRuns?: number): Config {
	return parseConfig({
		discord: { guildId: "g", allowedUserIds: ["u"] },
		limits: { maxChatSessions },
		workers: maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns },
	});
}

describe("healthLimits (RUN-10 to RUN-12)", () => {
	test("limits are null while settings are locked or unsaved", () => {
		expect(healthLimits(undefined, 10)).toEqual({ limits: null, warnings: [] });
	});

	test("maxChatSessions below capacity bounds concurrency and warns", () => {
		const { limits, warnings } = healthLimits(config(2), 10);
		expect(limits).toEqual({ maxChatSessions: 2, maxConcurrentRuns: 10, workerCapacity: 10, effectiveConcurrency: 2 });
		expect(warnings).toEqual(["maxChatSessions (2) is below worker capacity (10): at most 2 workers will be used"]);
	});

	test("maxChatSessions equal to capacity raises no warning", () => {
		expect(healthLimits(config(4), 4).warnings).toEqual([]);
	});

	test("maxConcurrentRuns above capacity warns; capacity still bounds concurrency", () => {
		const { limits, warnings } = healthLimits(config(10, 12), 10);
		expect(limits?.effectiveConcurrency).toBe(10);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith("workers.maxConcurrentRuns (12) exceeds worker capacity (10)");
	});

	test("maxConcurrentRuns below maxChatSessions bounds concurrency", () => {
		expect(healthLimits(config(8, 3), 10).limits?.effectiveConcurrency).toBe(3);
	});
});
