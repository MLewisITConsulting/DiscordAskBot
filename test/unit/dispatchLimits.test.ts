import { describe, expect, test } from "bun:test";
import { dispatchLimits } from "../../src/orchestrator/dispatch/workers";

describe("dispatchLimits (RUN-01)", () => {
	test("without saved settings no run can start", () => {
		expect(dispatchLimits(undefined, 4)).toBeUndefined();
	});

	test("the settings' caps, with maxConcurrentRuns defaulting to the worker capacity", () => {
		const limits = { maxChatSessions: 3, maxCostUsdPerTurn: 1, chatIdleMinutes: 30 };
		expect(dispatchLimits({ limits, workers: { reattachGraceSeconds: 90 } } as never, 4)).toEqual({ maxChatSessions: 3, maxConcurrentRuns: 4 });
		expect(dispatchLimits({ limits, workers: { maxConcurrentRuns: 1, reattachGraceSeconds: 90 } } as never, 4)).toEqual({ maxChatSessions: 3, maxConcurrentRuns: 1 });
	});
});
