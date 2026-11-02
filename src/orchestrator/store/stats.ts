import type { Loadout } from "../../shared/agent";
import type { StatusReport, UsageGroup, UsageWindow } from "../../shared/adminApi";
import type { Db } from "./db";

/** Usage accounting (OBS-05, OBS-06), setup times (NFR-06), active ask threads and the latest loadout (AGT-27) for the status page. */

export type UsageReport = StatusReport["usage"];

export const USAGE_WINDOWS: Readonly<Record<UsageWindow, number | undefined>> = Object.freeze({
	"24h": 24 * 3_600_000,
	"7d": 7 * 86_400_000,
	"30d": 30 * 86_400_000,
	all: undefined,
});

export const DEFAULT_USAGE_WINDOW: UsageWindow = "7d";

/** `?window=` value; unknown or missing → the default window. */
export function parseUsageWindow(raw: string | null | undefined): UsageWindow {
	return raw && Object.hasOwn(USAGE_WINDOWS, raw) ? (raw as UsageWindow) : DEFAULT_USAGE_WINDOW;
}

const DAILY_DAYS = 14;

const TOTALS_SQL = `COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(tokens_in), 0) AS tokensIn,
	COALESCE(SUM(tokens_out), 0) AS tokensOut, COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite`;

const MS_BETWEEN = (from: string, to: string) => `(julianday(${to}) - julianday(${from})) * 86400000`;

/** Usage of the window grouped by `column` (`channel_id` or `user_id`), highest cost first. */
function groupBy(db: Db, column: "channel_id" | "user_id", since: string): UsageGroup[] {
	return db.raw
		.query<UsageGroup, [string]>(
			`SELECT ${column} AS id, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(tokens_in), 0) AS tokensIn,
				COALESCE(SUM(tokens_out), 0) AS tokensOut
			FROM agent_runs WHERE finished_at >= ? GROUP BY ${column} ORDER BY costUsd DESC, id`,
		)
		.all(since);
}

/**
 * OBS-06: totals for the window, by ask channel and by Discord user (highest cost first), run counts by outcome with the
 * average duration, and the cost per UTC day for the last 14 days (oldest first, zero-filled, independent of the window).
 * NFR-06: setup time (claim → agent start) of the runs started in the window.
 */
export function usageReport(db: Db, window: UsageWindow, now = new Date()): UsageReport {
	const span = USAGE_WINDOWS[window];
	// "" sorts before every ISO timestamp, so it selects all rows for the unbounded window.
	const since = span === undefined ? "" : new Date(now.getTime() - span).toISOString();
	const raw = db.raw;

	const totals = raw.query<UsageReport["totals"], [string]>(`SELECT ${TOTALS_SQL} FROM agent_runs WHERE finished_at >= ?`).get(since)!;
	const counts = raw
		.query<{ finished: number; failed: number; stopped: number; limit: number; avgDurationMs: number | null }, [string]>(
			`SELECT COALESCE(SUM(outcome = 'finished'), 0) AS finished, COALESCE(SUM(outcome = 'failed'), 0) AS failed,
				COALESCE(SUM(outcome = 'stopped'), 0) AS stopped, COALESCE(SUM(outcome = 'limit'), 0) AS "limit",
				AVG(${MS_BETWEEN("started_at", "finished_at")}) AS avgDurationMs
			FROM agent_runs WHERE finished_at >= ?`,
		)
		.get(since)!;
	const outcomes = { ...counts, avgDurationMs: counts.avgDurationMs === null ? null : Math.round(counts.avgDurationMs) };
	const setupRow = raw
		.query<{ runs: number; avgMs: number | null; maxMs: number | null }, [string]>(
			`SELECT COUNT(*) AS runs, AVG(${MS_BETWEEN("claimed_at", "started_at")}) AS avgMs, MAX(${MS_BETWEEN("claimed_at", "started_at")}) AS maxMs
			FROM runs WHERE started_at IS NOT NULL AND claimed_at IS NOT NULL AND started_at >= ?`,
		)
		.get(since)!;
	const setup = setupRow.runs ? { runs: setupRow.runs, avgMs: Math.round(setupRow.avgMs ?? 0), maxMs: Math.round(setupRow.maxMs ?? 0) } : null;

	const firstDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (DAILY_DAYS - 1)));
	const perDay = new Map<string, number>();
	for (const row of raw
		.query<{ day: string; costUsd: number }, [string]>(
			`SELECT substr(finished_at, 1, 10) AS day, SUM(cost_usd) AS costUsd FROM agent_runs WHERE finished_at >= ? GROUP BY day`,
		)
		.all(firstDay.toISOString())) {
		perDay.set(row.day, row.costUsd);
	}
	const daily = Array.from({ length: DAILY_DAYS }, (_, i) => {
		const day = new Date(firstDay.getTime() + i * 86_400_000).toISOString().slice(0, 10);
		return { day, costUsd: perDay.get(day) ?? 0 };
	});

	return {
		window,
		...(span === undefined ? {} : { since }),
		totals,
		byChannel: groupBy(db, "channel_id", since),
		byUser: groupBy(db, "user_id", since),
		outcomes,
		daily,
		setup,
	};
}

/** Ask threads with a pending or active run, oldest run first. */
export function activeThreads(db: Db): StatusReport["activeThreads"] {
	return db.raw
		.query<StatusReport["activeThreads"][number], []>(
			`SELECT r.thread_id AS threadId, a.channel_id AS channelId, a.owner_id AS ownerId
			FROM runs r JOIN ask_chats a ON a.thread_id = r.thread_id WHERE r.state != 'finished' ORDER BY r.created_at`,
		)
		.all();
}

/** kv key holding the latest loadout of the `ask` profile (survives restarts, AGT-27). */
export const LOADOUT_KEY = "loadout:ask";

/** Records the loadout a session reported (AGT-27). */
export function saveLoadout(db: Db, loadout: Loadout): void {
	db.kvSet(LOADOUT_KEY, JSON.stringify(loadout));
}

/** The latest loadout; undefined before any run reported one. */
export function latestLoadout(db: Db): Loadout | undefined {
	const raw = db.kvGet(LOADOUT_KEY);
	return raw ? (JSON.parse(raw) as Loadout) : undefined;
}
