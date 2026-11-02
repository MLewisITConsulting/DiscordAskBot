import type { Dirent } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage, log } from "../../shared/log";

/**
 * omp session files the orchestrator keeps between runs (ENG-05), ported from DevForge `src/sessions.ts`. A session is
 * named by a file-name-safe **key** (`RunRequest.session`): its file is `<state>/sessions/<key>.jsonl`, and omp keeps
 * subagent transcripts and tool artifacts in the directory `<state>/sessions/<key>/`. The DB stores keys
 * (`ask_chats.session_file`, `runs.session_key`), never paths.
 */

const SESSION_SUFFIX = ".jsonl";
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** `<state>/sessions`, where ask sessions are kept between runs (ENG-05). */
export function sessionDir(stateDir: string): string {
	return join(stateDir, "sessions");
}

/** An ask thread's session (kept so the thread can resume, CHAT-03, ENG-05). */
export const chatSessionKey = (threadId: string): string => `chat-${threadId}`;

/** True when `key` names a session file directly inside the sessions directory. */
export function isSessionKey(key: string): boolean {
	return KEY_PATTERN.test(key) && !key.includes("..");
}

/** `<sessionDir>/<key>.jsonl`; throws for a key that is not file-name-safe. */
export function sessionPath(sessionDir: string, key: string): string {
	if (!isSessionKey(key)) throw new Error(`invalid session key: ${JSON.stringify(key)}`);
	return join(sessionDir, `${key}${SESSION_SUFFIX}`);
}

/** True when `path` lies strictly inside `dir`. */
function inside(dir: string, path: string): boolean {
	const rel = relative(resolve(dir), resolve(path));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function sizeOf(path: string): Promise<number | undefined> {
	try {
		return (await lstat(path)).size;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** Bytes of the files under `dir`; 0 when it does not exist. */
async function dirBytes(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { recursive: true, withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return 0;
		throw err;
	}
	let total = 0;
	for (const entry of entries) {
		if (entry.isDirectory()) continue;
		total += (await sizeOf(join(entry.parentPath, entry.name))) ?? 0;
	}
	return total;
}

/**
 * Deletes the sessions named by `keys` (file and artifacts dir). Never throws. A value that is not a session key, or that
 * would resolve outside `sessionDir`, is skipped with a warning (ENG-05). Returns the keys that could not be deleted.
 */
export async function removeSessions(
	sessionDir: string,
	keys: readonly (string | null | undefined)[],
	context: Record<string, unknown>,
): Promise<{ kept: string[] }> {
	const kept: string[] = [];
	const removed: string[] = [];
	let bytes = 0;
	for (const key of keys) {
		if (!key) continue;
		const file = isSessionKey(key) ? join(sessionDir, `${key}${SESSION_SUFFIX}`) : undefined;
		const dir = isSessionKey(key) ? join(sessionDir, key) : undefined;
		if (!file || !dir || !inside(sessionDir, file) || !inside(sessionDir, dir)) {
			log("warn", "session outside session dir skipped", { ...context, session: key });
			continue;
		}
		try {
			const fileBytes = await sizeOf(file);
			const dirSize = await dirBytes(dir);
			await rm(file, { force: true });
			await rm(dir, { recursive: true, force: true });
			if (fileBytes !== undefined || dirSize > 0) {
				removed.push(key);
				bytes += (fileBytes ?? 0) + dirSize;
			}
		} catch (err) {
			log("warn", "session removal failed", { ...context, session: key, error: errorMessage(err) });
			kept.push(key);
		}
	}
	if (removed.length > 0) log("info", "sessions removed", { ...context, sessions: removed, bytes });
	return { kept };
}
