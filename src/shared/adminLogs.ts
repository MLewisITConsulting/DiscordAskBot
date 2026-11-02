import type { LogSegment } from "./rollinglog";
import type { TranscriptEvent } from "./transcript";

/**
 * The agent transcript log and the orchestrator's process log over the admin API (OBS-03, OBS-04, `/logs`). Web
 * proxies the event stream and the file downloads; it never reads log files itself.
 */

/** One agent transcript entry, as the orchestrator's agent log keeps it (OBS-03). */
export type LogEntry = {
	/** `ask-<threadId>`: the ask thread's turns. */
	run: string;
	kind: "ask";
	/** The ask thread. */
	thread: string;
	/** The ask-only channel the thread is in. */
	channel: string;
	/** Discord user id of the person who started the thread. */
	user: string;
	seq: number;
	ts: string;
} & TranscriptEvent;

export interface LogFiles {
	/** Segment files, newest first. */
	segments: LogSegment[];
	/** That log's share of the log budget; undefined while it isn't known yet. */
	maxBytes?: number;
}

/** GET /internal/admin/logs?limit=<n> */
export interface LogsOverview {
	/** The newest entries (at most `limit`, default `LOGS_PAGE_ENTRIES`), oldest first. */
	entries: LogEntry[];
	agent: LogFiles;
	process: LogFiles;
}

/** Entries the `/logs` page starts with. */
export const LOGS_PAGE_ENTRIES = 500;
/** Rows the `/logs` page keeps; older ones are dropped as new entries arrive. Also the stream's backlog cap. */
export const MAX_LOG_ROWS = 2000;
/** Comment ping interval of the event stream. */
export const LOG_STREAM_PING_MS = 15_000;

/**
 * GET /internal/admin/logs/stream: `text/event-stream` of `LogEntry` (`id: <seq>`). With `Last-Event-ID` (a reconnect)
 * or `?after=<seq>` it first sends the kept entries after that sequence number; without either, only new entries.
 * A `: ping` comment every `LOG_STREAM_PING_MS`.
 */
export const LOG_STREAM_PATH = "/logs/stream";

/** GET /internal/admin/logs/files/<name>: one listed segment of either log; any other name is 404. */
export const LOG_FILES_PATH = "/logs/files/";
