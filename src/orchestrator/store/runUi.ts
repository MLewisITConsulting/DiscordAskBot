import type { RunUiState } from "../dispatch/dispatcher";
import type { Db } from "./db";

/**
 * RUN-14: the Discord state of a run's live messages (status message id, latest progress snapshot), stored per ask
 * thread in the key-value store as `runui:<threadId>`, so a follow-up turn finds it before its new run exists. A turn
 * re-attached after an orchestrator restart reads it to keep editing the same message; the engine clears it once done.
 */

export const runUiKey = (threadId: string): string => `runui:${threadId}`;

export interface RunUiStore {
	get(threadId: string): RunUiState | undefined;
	set(threadId: string, state: RunUiState): void;
	clear(threadId: string): void;
}

export function createRunUiStore(db: Db): RunUiStore {
	const remove = db.raw.query<null, [string]>("DELETE FROM kv WHERE key = ?");
	return {
		get(threadId) {
			const raw = db.kvGet(runUiKey(threadId));
			if (!raw) return undefined;
			try {
				return JSON.parse(raw) as RunUiState;
			} catch {
				return undefined;
			}
		},
		set: (threadId, state) => db.kvSet(runUiKey(threadId), JSON.stringify(state)),
		clear: threadId => void remove.run(runUiKey(threadId)),
	};
}
