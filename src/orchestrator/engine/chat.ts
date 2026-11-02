import { readFile } from "node:fs/promises";
import { errorMessage, log } from "../../shared/log";
import type { RunUsage } from "../../shared/transcript";
import { askThreadAllowed, memberAllowed } from "../discord/access";
import { type Progress, startProgress } from "../discord/progress";
import { activityText, chunkText, OOM_WARNING } from "../discord/render";
import { acknowledgeSteer } from "../discord/replies";
import type { CommandEvent, InAttachment, MessageEvent, OutMessage } from "../discord/surface";
import { CHAT_ICONS, setTopIcon } from "../discord/topMessage";
import { type AbortReason, RunDetached, type RunHandle, RunLost, type RunResult } from "../dispatch/dispatcher";
import type { AgentRunOutcome, AskChatRow } from "../store/db";
import { listOmpAssets } from "../store/ompAssets";
import type { AgentLogRun } from "../store/agentlog";
import { createRunUiStore } from "../store/runUi";
import {
	changedFiles,
	ensureScratchDirs,
	type FileSnapshot,
	listedFiles,
	MAX_COMMAND_FILES,
	MAX_INPUT_BYTES,
	MAX_INPUT_FILES,
	type ProducedFile,
	removeScratch,
	type SaveOptions,
	type ScratchPaths,
	saveAttachments,
	snapshotFiles,
	UPLOAD_LIMIT_BYTES,
} from "../store/scratch";
import { chatSessionKey } from "../store/sessions";
import { saveLoadout } from "../store/stats";
import type { EngineDeps } from "./deps";
import { ASK_MINUTES, askFollowUp, askPrompt, CHAT_SCHEMA, type ChatOutput } from "./prompts";

/**
 * `/ask` chats (CHAT-03 to CHAT-11, DSC-06, DSC-39), ported from the ask-only parts of DevForge `src/engine/chat.ts`
 * onto the surface and the dispatcher: each turn is an `ask` run on a worker; the thread's scratch directory lives in
 * the orchestrator and the dispatcher copies inputs to the worker and outputs back. Runs outlive the engine: stopping
 * it detaches (RUN-09), and starting it re-attaches to unfinished runs, editing the same messages (RUN-14).
 */

const SWEEP_INTERVAL_MS = 60_000;
/** The up-front refusal while `maxChatSessions` ask runs are active (CHAT-04). */
export const CAPACITY_REACHED = "Chat capacity reached; try again shortly.";
/** DSC-39: `/stop` in an ask thread with no pending or active run. */
export const NOTHING_RUNNING = "Nothing is running.";
export const SWEPT_NOTE = "files from earlier in this conversation were deleted after inactivity; ask the user to attach them again if you need them.";
export const ANSWER_TRUNCATED = "\n\n_[Answer truncated: it exceeded the upload limit.]_";
/** Most files Discord accepts in one message. */
const MAX_FILES_PER_MESSAGE = 10;
const MAX_MESSAGE = 2000;
const NO_USAGE: RunUsage = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface AskChatOptions {
	/** `<state>/scratch`. */
	scratchRoot: string;
	/** The admin's skills and agents (`ASKBOT_OMP_DIR`, AGT-24): whether a valid agent is installed decides the prompt (AGT-13). */
	ompDir: string;
	/** Downloads attachments; defaults to global `fetch`. */
	fetch?: SaveOptions["fetch"];
}

export interface AskChat {
	/** `/ask`, access already checked (DSC-03, DSC-04): admits, starts a one-day thread and runs the `ask` profile (CHAT-07). */
	command(e: CommandEvent): Promise<void>;
	/**
	 * A human message in a thread. False when the thread is not an ask thread; otherwise it was handled: ignored (DSC-06),
	 * steering for the live run, or a new run resuming the session (CHAT-03).
	 */
	message(e: MessageEvent): Promise<boolean>;
	/** The starter of ask thread `threadId`, or undefined when it is not an ask thread (DSC-39). */
	ownerOf(threadId: string): string | undefined;
	/** `/stop` in an ask thread, access already checked (DSC-39): stops the thread's run (CHAT-05); returns the reply text. */
	stop(threadId: string, by: string): Promise<string>;
	/** Engine start: re-attaches to the ask chats' unfinished runs (RUN-14) and starts the idle sweep (CHAT-06). */
	start(): void;
	/** Engine stop: stops the sweep and detaches from live runs, which keep going (RUN-09). */
	detach(): Promise<void>;
	/** CHAT-06, CHAT-11: removes the scratch directories of ask chats idle longer than `chatIdleMinutes`. */
	sweepIdle(): Promise<void>;
	/** threadId → settle promise of a run this engine is attached to. */
	readonly active: ReadonlyMap<string, Promise<void>>;
}

/** CHAT-10: `text` as UTF-8, cut to at most `limit` bytes with `note` appended; the cut never splits a character. */
export function truncateUtf8(text: string, limit: number, note: string): Uint8Array {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return bytes;
	const tail = Buffer.from(note, "utf8");
	let cut = Math.max(0, limit - tail.length);
	// A continuation byte (10xxxxxx) at the cut means the cut is inside a multi-byte sequence: move back to its start.
	while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
	return Buffer.concat([bytes.subarray(0, cut), tail]);
}

function mibText(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

/** `name` made unique among `taken` (`a.csv`, `a-1.csv`, …) and recorded there. */
function uniqueName(name: string, taken: Set<string>): string {
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let candidate = name;
	for (let n = 1; taken.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
	taken.add(candidate);
	return candidate;
}

/**
 * CHAT-10: the messages that deliver an ask run's result: the answer (if any) as an attached `answer.md` with a short
 * pointer (and the AGT-19 line when memory ran out), then the produced files in messages of at most 10 files and `limit`
 * bytes, then a line naming the files over `limit` (not attached). Files are read when the messages are built.
 */
export async function deliveryMessages(answer: string | undefined, files: ProducedFile[], limit: number, oomKills = 0): Promise<OutMessage[]> {
	const taken = new Set(answer === undefined ? [] : ["answer.md"]);
	const tooLarge: string[] = [];
	const batches: ProducedFile[][] = [];
	let batch: ProducedFile[] = [];
	let batchBytes = 0;
	for (const file of files) {
		if (file.size > limit) {
			tooLarge.push(file.name);
			continue;
		}
		if (batch.length === MAX_FILES_PER_MESSAGE || batchBytes + file.size > limit) {
			batches.push(batch);
			batch = [];
			batchBytes = 0;
		}
		batch.push(file);
		batchBytes += file.size;
	}
	if (batch.length > 0) batches.push(batch);
	const messages: OutMessage[] = [];
	if (answer !== undefined) {
		const attached = batches.reduce((n, b) => n + b.length, 0);
		const extra = attached > 0 ? ` and ${attached} generated file${attached === 1 ? "" : "s"} below` : "";
		messages.push({
			content: `📄 **Answer attached:** \`answer.md\`${extra}${oomKills > 0 ? `\n${OOM_WARNING}` : ""}`,
			files: [{ name: "answer.md", data: truncateUtf8(answer, limit, ANSWER_TRUNCATED) }],
		});
	}
	for (const b of batches) {
		messages.push({
			content: `📎 ${b.map(f => `\`${f.name}\``).join(", ")}`.slice(0, MAX_MESSAGE),
			files: await Promise.all(b.map(async f => ({ name: uniqueName(f.name, taken), data: new Uint8Array(await readFile(f.path)) }))),
		});
	}
	if (tooLarge.length > 0) messages.push({ content: `⚠️ Too large to attach (over ${mibText(limit)}): ${tooLarge.join(", ")}`.slice(0, MAX_MESSAGE) });
	return messages;
}

/**
 * AGT-08, AGT-31: the run will have `task` when at least one installed agent passes AGT-25, the rules the worker checks
 * again before it exposes `task`. A listing failure counts as none, so the prompt never promises a tool the run lacks.
 */
async function hasValidAgents(ompDir: string): Promise<boolean> {
	try {
		return (await listOmpAssets(ompDir)).agents.some(agent => !agent.problem);
	} catch (err) {
		log("warn", "listing agents failed", { error: errorMessage(err) });
		return false;
	}
}

/** OBS-06: how a turn that returned a result ended. */
function outcomeOf(aborted: AbortReason | undefined): AgentRunOutcome {
	if (aborted === "user") return "stopped";
	return aborted ? "limit" : "finished";
}

/** A new question or a follow-up; absent when re-attaching to a run after a restart (the prompt is not resent). */
interface Turn {
	prompt: string;
	resume: boolean;
}

export function createAskChat(deps: EngineDeps, opts: AskChatOptions): AskChat {
	const { config, db, discord, dispatcher } = deps;
	const agentName = config.agent.name;
	const runUi = createRunUiStore(db);
	const fetchFn = opts.fetch ?? ((url: string) => fetch(url));
	const active = new Map<string, Promise<void>>();
	/** threadId → handle of the live run (from `register`). */
	const handles = new Map<string, RunHandle>();
	/** Threads whose `/stop` came before their run registered: aborted as soon as it does (DSC-39). */
	const stopRequested = new Set<string>();
	/** Aborted by `detach()`; every run's signal also follows the engine's. */
	const detaching = new AbortController();
	const signal = AbortSignal.any([deps.signal, detaching.signal]);
	let sweepTimer: ReturnType<typeof setInterval> | undefined;

	/** A plain thread message, split to fit (DSC-14). Never throws. */
	async function notify(threadId: string, content: string): Promise<void> {
		try {
			for (const chunk of chunkText(content)) await discord.send(threadId, { content: chunk }, "high");
		} catch (err) {
			log("warn", "ask chat message failed", { thread: threadId, error: errorMessage(err) });
		}
	}

	/** Creates the thread's scratch directory (again after a sweep) and records it on the chat. */
	async function ensureScratch(threadId: string): Promise<ScratchPaths> {
		const paths = await ensureScratchDirs(opts.scratchRoot, threadId);
		db.updateAskChat(threadId, { scratch_dir: paths.root });
		return paths;
	}

	/** CHAT-08: downloads `attachments` into the thread's scratch directory; rejected files get a ⚠️ reply. Returns the saved paths. */
	async function saveInputs(threadId: string, attachments: InAttachment[], maxFiles: number): Promise<string[]> {
		const paths = await ensureScratch(threadId);
		if (attachments.length === 0) return [];
		const items = attachments.map(a => ({ name: a.name, url: a.url, size: a.size }));
		const { saved, skipped } = await saveAttachments(paths.root, items, { fetch: fetchFn, maxBytes: MAX_INPUT_BYTES, maxFiles });
		if (skipped.length > 0) {
			const lines = skipped.map(s => `- \`${s.name.replaceAll("`", "'").slice(0, 100)}\`: ${s.reason}`);
			await notify(threadId, `⚠️ **Couldn't use ${skipped.length === 1 ? "this file" : "these files"}:**\n${lines.join("\n")}`);
		}
		return saved;
	}

	/** True while the thread has a run starting, pending or active (CHAT-04, RUN-21). */
	const busy = (threadId: string) => active.has(threadId) || dispatcher.hasUnfinishedRun(threadId);

	/** DSC-06: the thread where `userId` already has a live run, counted from the runs (survives restarts). */
	function liveRunOf(userId: string): string | undefined {
		return db.askChatsOf(userId).find(chat => busy(chat.thread_id))?.thread_id;
	}

	/** CHAT-04: why a new run may not start now, or undefined. */
	function refusal(threadId: string | undefined, userId: string, allowed: boolean): string | undefined {
		if (threadId && busy(threadId)) return "Still starting the previous request; send that again in a moment.";
		if (active.size >= config.limits.maxChatSessions) return CAPACITY_REACHED;
		if (!allowed) {
			const other = liveRunOf(userId);
			if (other) return `You already have a request running in <#${other}>; wait for it to finish.`;
		}
		return undefined;
	}

	/** Runs one turn (or re-attaches to the live one) and tracks it in `active` until it settles. */
	function launch(chat: AskChatRow, turn: Turn | undefined): Promise<void> {
		const threadId = chat.thread_id;
		const done = run(chat, turn)
			.catch(err => log("error", "ask chat run failed", { thread: threadId, error: errorMessage(err) }))
			.finally(() => {
				active.delete(threadId);
				handles.delete(threadId);
				stopRequested.delete(threadId);
			});
		active.set(threadId, done);
		return done;
	}

	async function deliver(threadId: string, answer: string | undefined, files: ProducedFile[], oomKills = 0): Promise<void> {
		for (const message of await deliveryMessages(answer, files, UPLOAD_LIMIT_BYTES, oomKills)) await discord.send(threadId, message, "high");
	}

	/** The files the run produced (CHAT-10): as the dispatcher reported them, else whatever changed in `outputs/`. */
	async function produced(outputs: string, before: FileSnapshot, result: RunResult | undefined): Promise<ProducedFile[]> {
		try {
			return result?.outputs ? await listedFiles(outputs, result.outputs) : await changedFiles(outputs, before);
		} catch (err) {
			log("warn", "listing produced files failed", { error: errorMessage(err) });
			return [];
		}
	}

	async function run(chat: AskChatRow, turn: Turn | undefined): Promise<void> {
		const threadId = chat.thread_id;
		// Only a re-attach continues the stored message; a new turn posts its own and overwrites the state.
		const restore = turn ? undefined : runUi.get(threadId);
		const logRun: AgentLogRun = { run: `ask-${threadId}`, kind: "ask", thread: threadId, channel: chat.channel_id, user: chat.owner_id };
		const startedAt = new Date().toISOString();
		let progress: Progress | undefined;
		let paths: ScratchPaths | undefined;
		let before: FileSnapshot = new Map();
		let result: RunResult | undefined;
		let usage: RunUsage | undefined;
		/** OBS-05: every turn's usage, whatever its outcome; a detached turn is recorded by the engine that re-attaches. */
		const record = (outcome: AgentRunOutcome, oomKills = 0) => {
			try {
				db.recordRun({ threadId, channelId: chat.channel_id, userId: chat.owner_id, outcome, oomKills, startedAt, usage: usage ?? result?.usage ?? NO_USAGE });
			} catch (err) {
				log("error", "recording usage failed", { thread: threadId, error: errorMessage(err) });
			}
		};
		try {
			progress = await startProgress(discord, threadId, "Answering", "Preparing the workspace…", {
				restore,
				persist: state => runUi.set(threadId, state),
			});
			await setTopIcon(discord, threadId, CHAT_ICONS.working);
			paths = await ensureScratch(threadId);
			before = await snapshotFiles(paths.outputs);
			if (!restore) progress.phase("Starting the agent…");
			const current = progress;
			result = await dispatcher.runAgent(
				{
					threadId,
					profile: "ask",
					prompt: turn?.prompt ?? "",
					outputSchema: CHAT_SCHEMA,
					model: config.models.ask,
					thinking: config.models.thinking,
					limits: { minutes: ASK_MINUTES, costUsd: config.limits.maxCostUsdPerTurn },
					session: chatSessionKey(threadId),
					resume: turn?.resume ?? true,
					scratchDir: paths.root,
				},
				{
					register: handle => {
						handles.set(threadId, handle);
						if (stopRequested.has(threadId)) void handle.abort("user");
					},
					onWaitingForWorker: () => current.phase("Waiting for a worker…"),
					onProgress: p => current.activity(activityText(p.tool, p.intent), p.usage.costUsd),
					onTranscript: event => deps.agentLog.append(logRun, event),
					onLoadout: loadout => saveLoadout(db, loadout),
					onUsage: u => {
						usage = u;
					},
				},
				signal,
			);
			db.updateAskChat(threadId, { last_active_at: new Date().toISOString(), ...(result.hasSession ? { session_file: chatSessionKey(threadId) } : {}) });
			record(outcomeOf(result.aborted), result.oomKills);
			progress.phase("Posting the answer…", result.usage.costUsd);
			const files = await produced(paths.outputs, before, result);
			const oom = result.oomKills > 0 ? `\n${OOM_WARNING}` : "";
			if (result.aborted === "user") {
				// Files the agent already produced are delivered even when the run did not finish (CHAT-10).
				await deliver(threadId, undefined, files);
				await progress.finish("cancelled");
				await setTopIcon(discord, threadId, CHAT_ICONS.stopped);
				await notify(threadId, `⏹️ **Stopped.** Send another message to continue.${oom}`);
			} else if (result.aborted) {
				await deliver(threadId, undefined, files);
				await progress.finish("failed");
				await setTopIcon(discord, threadId, CHAT_ICONS.limit);
				const limit = result.aborted === "time" ? `${ASK_MINUTES} minute time limit` : `$${config.limits.maxCostUsdPerTurn} cost limit`;
				await notify(threadId, `⚠️ **Stopped at the ${limit}** before finishing. Send another message to continue where it left off.${oom}`);
			} else {
				await deliver(threadId, (result.output as ChatOutput).answer, files, result.oomKills);
				await progress.finish("done");
				await setTopIcon(discord, threadId, CHAT_ICONS.done);
				await notify(threadId, "✅ **Done.** Reply in this thread to follow up.");
			}
			runUi.clear(threadId);
		} catch (err) {
			if (err instanceof RunDetached || signal.aborted) {
				// The run keeps going; the next engine re-attaches and keeps editing the same message (RUN-14).
				progress?.stop();
				log("info", "ask chat detached", { thread: threadId });
				return;
			}
			log("error", "ask chat failed", { thread: threadId, error: errorMessage(err) });
			db.updateAskChat(threadId, { last_active_at: new Date().toISOString() });
			if (!result) record("failed");
			if (paths) await deliver(threadId, undefined, await produced(paths.outputs, before, result)).catch(() => {});
			await progress?.finish("failed");
			await setTopIcon(discord, threadId, CHAT_ICONS.failed);
			const reason = err instanceof RunLost ? err.message : errorMessage(err);
			await notify(threadId, `❌ **Failed:** ${reason.slice(0, 1500)}\nSend another message to try again.`);
			runUi.clear(threadId);
		}
	}

	/** CHAT-03: steers the live run with a follow-up, or starts a new run resuming the session. */
	async function followUp(e: MessageEvent, chat: AskChatRow): Promise<void> {
		const threadId = chat.thread_id;
		// After an idle sweep the scratch directory is gone (CHAT-11); saving recreates it.
		const swept = chat.scratch_dir === null;
		let saved: string[];
		try {
			saved = await saveInputs(threadId, e.attachments, MAX_INPUT_FILES);
		} catch (err) {
			log("error", "saving attachments failed", { thread: threadId, error: errorMessage(err) });
			await notify(threadId, `❌ **Couldn't prepare the workspace:** ${errorMessage(err).slice(0, 1500)}`);
			return;
		}
		const text = e.content.trim() || (saved.length > 0 ? "See the attached files." : "");
		if (!text) return;
		const handle = handles.get(threadId);
		if (handle) {
			// Delivery can wait for the worker (RUN-15); the message handler does not.
			void acknowledgeSteer(discord, e.ref, onQueued => handle.steer(askFollowUp(text, saved), e.actor.username, { onQueued, scratchInputs: saved })).catch(
				err => log("warn", "ask steer failed", { thread: threadId, error: errorMessage(err) }),
			);
			return;
		}
		const refused = refusal(threadId, e.actor.userId, memberAllowed(config, e.actor));
		if (refused) {
			await notify(threadId, refused);
			return;
		}
		db.updateAskChat(threadId, { last_active_at: new Date().toISOString() });
		// Always ask to resume: the dispatcher resumes whatever session the worker last uploaded (RUN-18), also after a
		// first turn whose worker was lost before it returned a result (RUN-04), and starts fresh when there is none.
		void launch(chat, { prompt: askFollowUp(text, saved, swept ? SWEPT_NOTE : undefined), resume: true });
	}

	async function sweepIdle(): Promise<void> {
		const cutoff = new Date(Date.now() - config.limits.chatIdleMinutes * 60_000).toISOString();
		for (const chat of db.idleAskChats(cutoff)) {
			if (!chat.scratch_dir || busy(chat.thread_id)) continue;
			try {
				// The session is kept so the conversation can resume (CHAT-06).
				if (await removeScratch(opts.scratchRoot, chat.scratch_dir)) {
					db.updateAskChat(chat.thread_id, { scratch_dir: null });
					log("info", "ask scratch removed", { thread: chat.thread_id });
				}
			} catch (err) {
				log("warn", "ask sweep failed", { thread: chat.thread_id, error: errorMessage(err) });
			}
		}
	}

	return {
		active,
		sweepIdle,
		async command(e) {
			const prompt = String(e.options.prompt ?? "").trim();
			const allowed = memberAllowed(config, e.actor);
			const refused = refusal(undefined, e.actor.userId, allowed);
			if (refused) {
				await e.reply({ content: refused, ephemeral: true });
				return;
			}
			await e.defer({ ephemeral: true });
			const top = await discord.send(e.where.channelId, { content: `💬 **${e.actor.username}** asked:\n${prompt}`.slice(0, MAX_MESSAGE) }, "high");
			const threadId = await discord.startThread(top, { name: prompt.slice(0, 100) || "Question", autoArchiveMinutes: 1440 });
			const chat = db.insertAskChat(threadId, e.where.channelId, e.actor.userId);
			log("info", "ask chat started", { thread: threadId, channel: e.where.channelId, user: e.actor.userId });
			await e.editReply({ content: `Started <#${threadId}>. Progress and the answer will appear there; reply in the thread to follow up.` });
			let saved: string[];
			try {
				saved = await saveInputs(threadId, e.attachments, MAX_COMMAND_FILES);
			} catch (err) {
				log("error", "saving attachments failed", { thread: threadId, error: errorMessage(err) });
				await notify(threadId, `❌ **Couldn't prepare the workspace:** ${errorMessage(err).slice(0, 1500)}`);
				return;
			}
			// Re-checked: another request may have taken the last slot while the files downloaded.
			const late = refusal(threadId, e.actor.userId, allowed);
			if (late) {
				await notify(threadId, late);
				return;
			}
			void launch(chat, { prompt: askPrompt(agentName, prompt, saved, await hasValidAgents(opts.ompDir)), resume: false });
		},
		async message(e) {
			const chat = db.getAskChat(e.where.channelId);
			if (!chat) return false;
			// DSC-06: only the thread starter or an allowed member; everyone else is ignored silently.
			if (!askThreadAllowed(config, e.actor, chat.owner_id)) return true;
			try {
				await followUp(e, chat);
			} catch (err) {
				log("error", "ask thread message failed", { thread: chat.thread_id, error: errorMessage(err) });
			}
			return true;
		},
		ownerOf: threadId => db.getAskChat(threadId)?.owner_id,
		async stop(threadId, by) {
			// DSC-39: with no pending or active run, nothing changes.
			if (!busy(threadId)) return NOTHING_RUNNING;
			log("info", "ask chat stop requested", { thread: threadId, by });
			// One-shot (AGT-07, NFR-05): a second /stop finds the same run already stopping.
			stopRequested.add(threadId);
			const handle = handles.get(threadId);
			if (handle) await handle.abort("user");
			return "Stopping…";
		},
		start() {
			for (const chat of db.allAskChats()) {
				// A run that finished while no engine was attached still holds its answer (NFR-03).
				if (active.has(chat.thread_id) || !dispatcher.hasRun(chat.thread_id)) continue;
				log("info", "ask chat re-attached after start", { thread: chat.thread_id });
				void launch(chat, undefined);
			}
			sweepTimer = setInterval(() => {
				sweepIdle().catch(err => log("error", "ask sweep failed", { error: errorMessage(err) }));
			}, SWEEP_INTERVAL_MS);
		},
		async detach() {
			clearInterval(sweepTimer);
			detaching.abort();
			await Promise.allSettled([...active.values()]);
		},
	};
}
