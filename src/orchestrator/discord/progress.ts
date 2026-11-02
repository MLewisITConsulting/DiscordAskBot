import { errorMessage, log } from "../../shared/log";
import type { RunUiState } from "../dispatch/dispatcher";
import { type ProgressState, progressLine } from "./render";
import type { DiscordSurface, MsgRef, Priority } from "./surface";

/** Minimum gap between edits caused by agent activity; state changes edit immediately (DSC-11). */
export const ACTIVITY_EDIT_MS = 5_000;
/** Refreshes the elapsed time while the agent is quiet (long thinking), so the message never looks stuck. */
export const HEARTBEAT_MS = 15_000;

/** The one live, edited status message of an ask turn that shows what the agent is doing right now (DSC-10). */
export interface Progress {
	/** The agent's current action (tool and intent) and cost so far; edits are throttled. */
	activity(text: string, cost?: number): void;
	/** A step the system itself takes (waiting for a worker, posting the answer, …); shown immediately. */
	phase(text: string, cost?: number): void;
	/** Shows the final state and stops updating. */
	finish(state: Exclude<ProgressState, "running">): Promise<void>;
	/**
	 * Stops the heartbeat and every later edit without writing a final state: the engine detached from a run that keeps
	 * going (ENG-02), and the next engine re-attaches to it.
	 */
	stop(): void;
	ref(): MsgRef;
}

export interface ProgressOptions {
	/**
	 * RUN-14: the stored state of a run this progress continues after an orchestrator restart. The status message it
	 * names is edited again (re-rendered from the snapshot); one that was deleted is posted anew.
	 */
	restore?: RunUiState;
	/** RUN-14: called with the current state whenever the message id or the snapshot changes. */
	persist?(state: RunUiState): void;
}

/** A stored message that still exists, or undefined (deleted, or the lookup failed). */
async function existing(surface: DiscordSurface, ref: MsgRef | undefined): Promise<MsgRef | undefined> {
	if (!ref) return undefined;
	try {
		return (await surface.fetchMessage(ref)) ? ref : undefined;
	} catch (err) {
		log("debug", "progress message lookup failed", { channel: ref.channelId, message: ref.messageId, error: errorMessage(err) });
		return undefined;
	}
}

export async function startProgress(surface: DiscordSurface, channelId: string, title: string, activity: string, opts: ProgressOptions = {}): Promise<Progress> {
	const snapshot = opts.restore?.progress;
	// A restored run keeps its elapsed time.
	const startedAt = Date.now() - (snapshot?.elapsedMs ?? 0);
	const state = {
		status: "running" as ProgressState,
		activity: snapshot?.activity ?? activity,
		cost: snapshot?.costUsd ?? 0,
		lastEdit: Date.now(),
	};
	const elapsed = () => Date.now() - startedAt;
	const render = () => progressLine({ title, state: state.status, elapsedMs: elapsed(), cost: state.cost, activity: state.activity });

	const kept = await existing(surface, opts.restore?.statusMessage);
	const ref = kept ?? (await surface.send(channelId, { content: render() }, "high"));
	const persist = () => {
		try {
			opts.persist?.({ statusMessage: ref, progress: { state: state.status, activity: state.activity, elapsedMs: elapsed(), costUsd: state.cost } });
		} catch (err) {
			log("warn", "progress state not stored", { error: errorMessage(err) });
		}
	};
	// Edits go through the outbound queue, which serialises and coalesces them (DSC-32). Failures are only logged:
	// progress display must never change how a run ends (DSC-11).
	let last: Promise<void> = Promise.resolve();
	const edit = (priority: Priority) => {
		state.lastEdit = Date.now();
		persist();
		last = surface.edit(ref, { content: render() }, priority).catch(err => {
			log("debug", "progress edit failed", { channel: ref.channelId, message: ref.messageId, error: errorMessage(err) });
		});
		return last;
	};
	if (kept) await edit("state");
	else persist();
	const heartbeat = setInterval(() => void edit("activity"), HEARTBEAT_MS);
	let finished = false;

	return {
		activity(text, cost) {
			if (finished) return;
			state.activity = text;
			if (cost !== undefined) state.cost = cost;
			// Quieter updates are picked up by the next edit or heartbeat.
			if (Date.now() - state.lastEdit >= ACTIVITY_EDIT_MS) void edit("activity");
		},
		phase(text, cost) {
			if (finished) return;
			state.activity = text;
			if (cost !== undefined) state.cost = cost;
			void edit("state");
		},
		async finish(final) {
			if (finished) return;
			finished = true;
			clearInterval(heartbeat);
			state.status = final;
			await edit("state");
		},
		stop() {
			finished = true;
			clearInterval(heartbeat);
		},
		ref: () => ref,
	};
}
