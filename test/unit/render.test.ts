import { describe, expect, test } from "bun:test";
import { activityText, chunkText, progressLine } from "../../src/orchestrator/discord/render";

test("progress line shows the current activity only while running (DSC-10)", () => {
	const base = { title: "Answering", elapsedMs: 192_000, cost: 1.5, activity: "Reading the input (`read_file`)" };
	const running = progressLine({ ...base, state: "running" });
	expect(running.split("\n")).toEqual(["🛠️ **Answering** · working · 3m 12s · $1.50", "↳ Reading the input (`read_file`)"]);
	expect(progressLine({ ...base, state: "done" })).toBe("✅ **Answering** · finished · 3m 12s · $1.50");
	expect(progressLine({ ...base, state: "failed" })).toBe("❌ **Answering** · failed · 3m 12s · $1.50");
	expect(progressLine({ ...base, state: "cancelled" })).toBe("⏹️ **Answering** · cancelled · 3m 12s · $1.50");
});

test("activity names the tool and its intent", () => {
	expect(activityText(undefined, undefined)).toBe("Thinking…");
	expect(activityText("web_search", undefined)).toBe("Running `web_search`");
	expect(activityText("web_search", "Searching the news")).toBe("Searching the news (`web_search`)");
});

describe("chunkText (DSC-14)", () => {
	test("keeps paragraphs together", () => {
		const a = "a".repeat(1200);
		const b = "b".repeat(1200);
		expect(chunkText(`${a}\n\n${b}`)).toEqual([a, b]);
		expect(chunkText("x\n\ny")).toEqual(["x\n\ny"]);
	});

	test("hard-splits oversize paragraphs", () => {
		const chunks = chunkText("z".repeat(4500));
		expect(chunks.map(c => c.length)).toEqual([2000, 2000, 500]);
	});
});
