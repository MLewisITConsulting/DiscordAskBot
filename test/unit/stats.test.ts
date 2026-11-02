import { describe, expect, test } from "bun:test";
import { type AgentRunOutcome, type Db, openDb } from "../../src/orchestrator/store/db";
import { activeThreads, LOADOUT_KEY, latestLoadout, parseUsageWindow, saveLoadout, usageReport } from "../../src/orchestrator/store/stats";
import type { Loadout } from "../../src/shared/agent";

const NOW = new Date("2026-10-15T12:00:00.000Z");

interface RunOpts {
	channel?: string;
	user?: string;
	outcome?: AgentRunOutcome;
	durationMs?: number;
	input?: number;
}

/** Records a run that finished `hoursAgo` before NOW after `durationMs` (recordRun stamps the real clock, so patch it). */
function run(db: Db, costUsd: number, hoursAgo: number, opts: RunOpts = {}) {
	const finished = new Date(NOW.getTime() - hoursAgo * 3_600_000);
	const started = new Date(finished.getTime() - (opts.durationMs ?? 60_000));
	db.recordRun({
		threadId: "t",
		channelId: opts.channel ?? "c1",
		userId: opts.user ?? "u1",
		outcome: opts.outcome ?? "finished",
		startedAt: started.toISOString(),
		usage: { costUsd, input: opts.input ?? 100, output: 10, cacheRead: 5, cacheWrite: 1 },
	});
	db.raw.run("UPDATE agent_runs SET finished_at = ? WHERE id = (SELECT MAX(id) FROM agent_runs)", [finished.toISOString()]);
}

describe("usageReport (OBS-06)", () => {
	test("windows filter by finish time; totals split by ask channel and by user, highest cost first", () => {
		const db = openDb(":memory:");
		run(db, 1, 1, { channel: "c1", user: "alice" });
		run(db, 2, 30, { channel: "c2", user: "bob" });
		run(db, 0.5, 24 * 10, { channel: "c2", user: "alice" });
		run(db, 4, 24 * 40, { channel: "c1", user: "carol", input: 1000 });

		const day = usageReport(db, "24h", NOW);
		expect(day.totals).toEqual({ runs: 1, costUsd: 1, tokensIn: 100, tokensOut: 10, cacheRead: 5, cacheWrite: 1 });
		expect(day.since).toBe("2026-10-14T12:00:00.000Z");

		const week = usageReport(db, "7d", NOW);
		expect(week.totals.runs).toBe(2);
		expect(week.byChannel).toEqual([
			{ id: "c2", runs: 1, costUsd: 2, tokensIn: 100, tokensOut: 10 },
			{ id: "c1", runs: 1, costUsd: 1, tokensIn: 100, tokensOut: 10 },
		]);

		const all = usageReport(db, "all", NOW);
		expect(all.since).toBeUndefined();
		expect(all.totals.costUsd).toBe(7.5);
		expect(all.byChannel.map(g => [g.id, g.runs, g.costUsd])).toEqual([
			["c1", 2, 5],
			["c2", 2, 2.5],
		]);
		expect(all.byUser).toEqual([
			{ id: "carol", runs: 1, costUsd: 4, tokensIn: 1000, tokensOut: 10 },
			{ id: "bob", runs: 1, costUsd: 2, tokensIn: 100, tokensOut: 10 },
			{ id: "alice", runs: 2, costUsd: 1.5, tokensIn: 200, tokensOut: 20 },
		]);
	});

	test("run counts by outcome and the average duration; none in the window reads zero and null", () => {
		const db = openDb(":memory:");
		expect(usageReport(db, "7d", NOW).outcomes).toEqual({ finished: 0, failed: 0, stopped: 0, limit: 0, avgDurationMs: null });
		run(db, 1, 1, { outcome: "finished", durationMs: 10_000 });
		run(db, 1, 1, { outcome: "finished", durationMs: 20_000 });
		run(db, 1, 1, { outcome: "failed", durationMs: 30_000 });
		run(db, 1, 1, { outcome: "stopped", durationMs: 40_000 });
		run(db, 1, 1, { outcome: "limit", durationMs: 50_000 });
		run(db, 1, 24 * 30, { outcome: "failed", durationMs: 1_000_000 });
		expect(usageReport(db, "7d", NOW).outcomes).toEqual({ finished: 2, failed: 1, stopped: 1, limit: 1, avgDurationMs: 30_000 });
	});

	test("daily series covers 14 UTC days oldest first, zero-filled", () => {
		const db = openDb(":memory:");
		run(db, 1, 1);
		run(db, 2, 2);
		run(db, 3, 24 * 3);
		run(db, 9, 24 * 20);
		const { daily } = usageReport(db, "7d", NOW);
		expect(daily).toHaveLength(14);
		expect(daily[0]!.day).toBe("2026-10-02");
		expect(daily.at(-1)).toEqual({ day: "2026-10-15", costUsd: 3 });
		expect(daily.find(d => d.day === "2026-10-12")).toEqual({ day: "2026-10-12", costUsd: 3 });
		expect(daily.find(d => d.day === "2026-10-13")).toEqual({ day: "2026-10-13", costUsd: 0 });
		expect(daily.reduce((sum, d) => sum + d.costUsd, 0)).toBe(6);
	});

	test("setup time: claim and agent start are recorded; runs started in the window count (NFR-06)", () => {
		const db = openDb(":memory:");
		db.insertAskChat("t0", "c1", "u1");
		// Recording: the claim stamps claimed_at, `registered` (→ running) stamps started_at.
		const recorded = db.insertRun({ threadId: "t0" });
		const claimed = db.claimRun("worker-1", 60_000)!;
		expect(claimed.id).toBe(recorded.id);
		expect(claimed.claimed_at).not.toBeNull();
		expect(claimed.started_at).toBeNull();
		const started = db.transitionRun(recorded.id, ["assigned"], "running")!;
		expect(Date.parse(started.started_at!)).toBeGreaterThanOrEqual(Date.parse(claimed.claimed_at!));

		db.raw.run("DELETE FROM runs");
		expect(usageReport(db, "24h", NOW).setup).toBeNull();
		const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
		const setupRun = (thread: string, setupMs: number, startedMsAgo: number) => {
			db.insertAskChat(thread, "c1", "u1");
			const row = db.insertRun({ threadId: thread });
			db.raw.run("UPDATE runs SET claimed_at = ?, started_at = ? WHERE id = ?", [at(startedMsAgo + setupMs), at(startedMsAgo), row.id]);
		};
		setupRun("t1", 10_000, 3_600_000);
		setupRun("t2", 300_000, 3_600_000);
		setupRun("t3", 20_000, 7_200_000);
		setupRun("t4", 900_000, 3 * 86_400_000); // outside 24h
		// Never started (still setting up): not counted.
		db.insertAskChat("t5", "c1", "u1");
		db.insertRun({ threadId: "t5" });

		expect(usageReport(db, "24h", NOW).setup).toEqual({ runs: 3, avgMs: 110_000, maxMs: 300_000 });
		expect(usageReport(db, "7d", NOW).setup).toEqual({ runs: 4, avgMs: 307_500, maxMs: 900_000 });
	});
});

test("parseUsageWindow falls back to 7d for unknown values", () => {
	expect(parseUsageWindow("24h")).toBe("24h");
	expect(parseUsageWindow("all")).toBe("all");
	expect(parseUsageWindow("toString")).toBe("7d");
	expect(parseUsageWindow(null)).toBe("7d");
});

test("activeThreads lists ask threads with an unfinished run, oldest first", () => {
	const db = openDb(":memory:");
	db.insertAskChat("t1", "c1", "alice");
	db.insertAskChat("t2", "c2", "bob");
	db.insertAskChat("t3", "c1", "carol");
	db.insertRun({ threadId: "t1" });
	const done = db.insertRun({ threadId: "t2" });
	db.transitionRun(done.id, ["pending"], "finished");
	db.insertRun({ threadId: "t3" });
	expect(activeThreads(db)).toEqual([
		{ threadId: "t1", channelId: "c1", ownerId: "alice" },
		{ threadId: "t3", channelId: "c1", ownerId: "carol" },
	]);
});

test("the latest loadout survives in kv (AGT-27)", () => {
	const db = openDb(":memory:");
	expect(latestLoadout(db)).toBeUndefined();
	const loadout: Loadout = { capturedAt: NOW.toISOString(), profile: "ask", tools: ["read_file", "yield"], skills: [], agents: [] };
	saveLoadout(db, loadout);
	expect(db.kvGet(LOADOUT_KEY)).toBe(JSON.stringify(loadout));
	expect(latestLoadout(db)).toEqual(loadout);
});
