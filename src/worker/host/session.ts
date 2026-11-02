import {
	AgentRegistry,
	type AgentSessionEvent,
	type AuthStorage,
	type AuthStorageOptions,
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	REMOTE_REFRESH_SENTINEL,
	SessionManager,
	type YieldDetails,
} from "@oh-my-pi/pi-coding-agent";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { type SubagentEventPayload, TASK_SUBAGENT_EVENT_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { AgentProfile } from "../../shared/agent";
import { errorMessage, log } from "../../shared/log";
import { initRunSettings } from "../../shared/ompconfig";
import type { HostResult, HostRuntime } from "../../shared/protocol";
import type { TranscriptEvent } from "../../shared/transcript";
import { validateAgents } from "./agents";
import { captureLoadout } from "./loadout";
import { readOomKills } from "./oom";
import { createScratchTools } from "./scratchTools";
import { type AbortReason, type CredentialRequester, NoStructuredOutput, type SessionOptions } from "./serve";
import { createUsageMeter } from "./usage";

/**
 * One omp agent session, run inside the agent host (`host.ts`), one run per process. The worker supervisor spawns the
 * host with `HOME` and `PI_CODING_AGENT_DIR` pointing at run-local directories (spike S2) and seeds the run-private
 * auth store `<agentDir>/agent.db` from the run spec (CRED-02).
 */

/** SDK singletons of one agent process. */
export interface SessionRuntime {
	agentDir: string;
	/** The downloaded skills and agents: the only extension root sessions load (AGT-24). */
	ompDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/**
 * omp's `refreshOAuthCredential` hook (S1, CRED-03): every refresh becomes a `credential_request` carrying the local
 * row id (the supervisor maps it to the orchestrator's id). The refresh token never leaves the orchestrator, so the
 * stored row keeps the `__remote__` sentinel. A refusal rejects; its "revoked" text makes omp disable the copy.
 */
export function credentialRefreshHook(requestCredential: CredentialRequester): NonNullable<AuthStorageOptions["refreshOAuthCredential"]> {
	return async (provider, credentialId, credential, signal) => {
		const fresh = await requestCredential({ provider, credentialId: String(credentialId), accessToken: credential.access }, signal);
		const { type: _type, ...identity } = credential;
		return { ...identity, access: fresh.accessToken, refresh: REMOTE_REFRESH_SENTINEL, expires: fresh.expiresAt };
	};
}

/**
 * Opens the run-private auth store `<agentDir>/agent.db` (seeded by the supervisor) with the refresh hook, installs the
 * provider keys as in-memory runtime overrides, and builds the model registry (AGT-03).
 */
export async function openSessionRuntime(runtime: HostRuntime, requestCredential: CredentialRequester): Promise<SessionRuntime> {
	const { agentDir, ompDir, providerKeys } = runtime;
	// omp resolves its agent dir from the environment when it loads; a different one would put files outside the run dir (S2).
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (!envDir || resolve(envDir) !== resolve(agentDir)) {
		throw new Error(`PI_CODING_AGENT_DIR (${envDir ?? "unset"}) must be the run's agent dir ${agentDir}, set before the host starts`);
	}
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	const authStorage = await discoverAuthStorage(agentDir, { authStorageOptions: { refreshOAuthCredential: credentialRefreshHook(requestCredential) } });
	for (const [provider, key] of Object.entries(providerKeys)) authStorage.keys.setRuntime(provider, key);
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
	await modelRegistry.refresh();
	return { agentDir, ompDir, authStorage, modelRegistry };
}

/** AGT-18: names the tool, tells the agent not to repeat it, and asks it to tell the user the step was cut short. */
function oomSteer(kills: number, tool: string): string {
	return `The kernel killed ${kills} process(es) on this machine for lack of memory (OOM) while your last \`${tool}\` call ran, so that step was cut short. This machine does not have enough memory for it. Do not repeat that action: it will run out of memory again. Continue without it, and tell the user in your answer that this step was cut short because memory ran out.`;
}

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

const THINKING_LEVELS: Record<ThinkingLevel, true> = {
	auto: true,
	inherit: true,
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

/**
 * The tools of each profile (AGT-08, AGT-09): only the scratch-confined file tools, no omp file or shell tools. `task`
 * is added when at least one valid agent is installed.
 */
const PROFILE_TOOLS: Record<AgentProfile, string[]> = {
	ask: ["web_search", "list_files", "read_file", "write_file", "yield"],
};

/**
 * AGT-24: omp looks up project skills and agents in `.omp` from the cwd up to `/` (spikes A1, A2), so the session's cwd
 * must be outside the scratch dir the agent writes, and no `.omp` may exist in it or above it.
 */
export function checkSessionCwd(cwd: string, scratchRoot: string): void {
	const abs = resolve(cwd);
	const rel = relative(resolve(scratchRoot), abs);
	if (!rel.startsWith("..") && !rel.startsWith("/")) throw new Error(`The session's working directory ${abs} must be outside the scratch directory`);
	for (let dir = abs; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".omp"))) throw new Error(`The session's working directory ${abs} has an .omp directory in or above it (${dir})`);
		if (dirname(dir) === dir) return;
	}
}

/** AGT-14. */
const WALL_CLOCK_CHECK_MS = 15_000;
const YIELD_NUDGE = "You have not called yield. Call yield now with data matching the required schema.";

export async function runSession(runtime: SessionRuntime, opts: SessionOptions): Promise<HostResult> {
	const run = opts.runId;
	if (!Object.hasOwn(THINKING_LEVELS, opts.thinking)) throw new Error(`Unknown thinking level "${opts.thinking}"`);
	const thinkingLevel = opts.thinking as ThinkingLevel;
	checkSessionCwd(opts.cwd, opts.scratchRoot);
	// AGT-31: invalid agents are deleted before omp can see them; the valid ones are the only spawnable agents.
	const agents = await validateAgents(runtime.ompDir, run);
	const toolNames = [...PROFILE_TOOLS[opts.profile], ...(agents.length > 0 ? ["task"] : [])];
	// AGT-24: the omp dir is the only skill source; an explicit list turns omp's skill discovery off (spike A1).
	const skillsDir = join(runtime.ompDir, "skills");
	const { skills } = await loadSkillsFromDir({ dir: skillsDir, source: "askbot:user" });
	// Live events of task subagents (AGT-32).
	const subagentEvents = new EventBus();
	const sessionManager = opts.resumeFile
		? await SessionManager.open(opts.resumeFile, opts.sessionDir, undefined, { initialCwd: opts.cwd })
		: SessionManager.create(opts.cwd, opts.sessionDir);

	const omp = opts.omp;
	// Admin overrides with the pinned headless values on top; also the process-global settings web_search reads (AGT-11).
	const settings = await initRunSettings(omp, runtime.agentDir);
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir: runtime.agentDir,
		// Always both: omp code paths without a store open their own, without the refresh hook (S1, CRED-03).
		authStorage: runtime.authStorage,
		modelRegistry: runtime.modelRegistry,
		sessionManager,
		settings,
		agentRegistry: new AgentRegistry(),
		hasUI: false,
		interactivePrompts: false,
		enableMCP: false,
		disableExtensionDiscovery: true,
		// The only extension root: the downloaded skills and agents (AGT-24).
		additionalExtensionPaths: [runtime.ompDir],
		skills,
		// AGT-31: the only spawnable agents (task description and preflight); "" disables spawning (spike A2).
		spawns: agents.map(agent => agent.name).join(","),
		subagentEventBus: subagentEvents,
		modelPattern: opts.modelPattern,
		thinkingLevel,
		outputSchema: opts.outputSchema,
		outputSchemaMode: "strict",
		requireYieldTool: !!opts.outputSchema,
		// The scratch-confined file tools (AGT-28, AGT-29).
		customTools: createScratchTools({ scratch: opts.scratchRoot, skills: skillsDir }),
		allowRestrictedCustomTools: true,
		toolNames,
		restrictToolNames: true,
	});

	const start = Date.now();
	let output: unknown;
	let aborted: AbortReason | undefined;
	let lastTool: { tool?: string; intent?: string } = {};
	const meter = createUsageMeter(session);

	// One-shot: the first reason wins (AGT-07).
	const abortWith = (reason: AbortReason) => {
		if (aborted) return;
		aborted = reason;
		log("warn", "agent aborted", { run, reason, cost: meter.total.costUsd });
		session.abort().catch(err => log("warn", "agent abort failed", { run, error: errorMessage(err) }));
	};
	const elapsedMs = () => Date.now() - start;

	const transcript = (event: TranscriptEvent) => {
		try {
			opts.onTranscript(event);
		} catch (err) {
			log("warn", "transcript sink failed", { run, error: errorMessage(err) });
		}
	};

	// Container-wide kernel OOM counter (AGT-17); `undefined` = no cgroup v2, detection off.
	let oomSeen = readOomKills();
	let oomKills = 0;
	const checkOom = (tool: string) => {
		if (oomSeen === undefined) return;
		const now = readOomKills();
		if (now === undefined || now <= oomSeen) return;
		const delta = now - oomSeen;
		oomSeen = now;
		oomKills += delta;
		log("warn", "process OOM-killed during agent run", { run, tool, kills: delta, total: oomKills });
		// AGT-18: never after a successful yield (a steer would start a turn the post-yield contingency aborts) or an abort.
		if (output !== undefined || aborted) return;
		const text = oomSteer(delta, tool);
		transcript({ type: "steer", text });
		session.steer(text).catch(err => log("warn", "oom steer failed", { run, error: errorMessage(err) }));
	};

	// AGT-32: a running subagent's cost counts against the limit as it accrues. The parent's stats include it once the
	// `task` call has returned, so the turn's end resets this.
	let childCost = 0;
	const unsubscribeSubagents = subagentEvents.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
		const { event } = data as SubagentEventPayload;
		if (event.type !== "message_end" || !("role" in event.message) || event.message.role !== "assistant") return;
		childCost += event.message.usage?.cost?.total ?? 0;
		if (meter.total.costUsd + childCost > opts.limits.costUsd) abortWith("cost");
	});

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "tool_execution_start":
				lastTool = { tool: event.toolName, intent: event.intent };
				opts.onProgress({ ...lastTool, usage: { ...meter.total }, elapsedMs: elapsedMs() });
				transcript({ type: "tool_start", tool: event.toolName, intent: event.intent, args: JSON.stringify(event.args ?? null) });
				break;
			case "tool_execution_end": {
				transcript({ type: "tool_end", tool: event.toolName, isError: !!event.isError, text: toolResultText(event.result) });
				if (event.toolName === "yield" && !event.isError) {
					const details = (event.result as { details?: YieldDetails } | undefined)?.details;
					if (details?.status === "success") output = details.data;
				}
				// After the yield is captured: kills seen at a successful yield are counted but not steered (AGT-18).
				checkOom(event.toolName);
				break;
			}
			case "turn_start":
				// Contingency: yield should end a top-level run. If the loop starts another turn after a
				// successful yield, stop it; the captured output is the result.
				if (output !== undefined && !aborted) {
					log("info", "agent continued after yield; aborting", { run });
					session.abort().catch(err => log("warn", "agent abort failed", { run, error: errorMessage(err) }));
				}
				break;
			case "message_end": {
				const message = event.message;
				if (!("role" in message) || message.role !== "assistant") break;
				const text = message.content
					.flatMap(block => (block.type === "text" ? [block.text] : []))
					.join("")
					.trim();
				if (text) transcript({ type: "assistant", text });
				break;
			}
			case "turn_end": {
				// Cost is checked at the end of every turn (AGT-14).
				const usage = { ...meter.update() };
				childCost = 0;
				opts.onProgress({ ...lastTool, usage, elapsedMs: elapsedMs() });
				if (usage.costUsd > opts.limits.costUsd) abortWith("cost");
				break;
			}
		}
	});
	const clock = setInterval(() => {
		if (elapsedMs() > opts.limits.minutes * 60_000) abortWith("time");
	}, WALL_CLOCK_CHECK_MS);

	let runError: string | undefined;
	try {
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Agent session has no session file");
		const active = session.getActiveToolNames();
		const missing = toolNames.filter(name => !active.includes(name));
		if (missing.length > 0) log("warn", "profile tools unavailable", { run, profile: opts.profile, missing });
		await opts.onSessionFile(sessionFile);
		if (opts.onLoadout) {
			const disabledAgents = omp.settings["task.disabledAgents"];
			await captureLoadout(session, {
				agents,
				profile: opts.profile,
				disabledAgents: Array.isArray(disabledAgents) ? disabledAgents.filter(a => typeof a === "string") : [],
			})
				.then(opts.onLoadout)
				.catch(err => log("warn", "loadout capture failed", { run, error: errorMessage(err) }));
		}
		opts.register({
			steer: async text => {
				transcript({ type: "steer", text });
				await session.steer(text);
			},
			abort: async reason => {
				abortWith(reason);
				await session.abort();
			},
		});

		const prompt = async (text: string) => {
			transcript({ type: "prompt", text });
			try {
				await session.prompt(text);
				await session.waitForIdle();
			} catch (err) {
				// An abort (ours or the post-yield contingency) can surface as a rejected prompt.
				if (!aborted && output === undefined) throw err;
			}
		};
		await prompt(opts.prompt);
		if (opts.outputSchema && output === undefined && !aborted) {
			// One nudge (AGT-12). The session is idle here, so it must start a new turn: prompt, not a queued followUp.
			await prompt(YIELD_NUDGE);
		}
		checkOom("agent run");
		const usage = { ...meter.update() };
		if (opts.outputSchema && output === undefined && !aborted) throw new NoStructuredOutput();
		return { output, sessionFile, usage, oomKills, ...(aborted ? { aborted } : {}) };
	} catch (err) {
		runError = errorMessage(err);
		throw err;
	} finally {
		clearInterval(clock);
		unsubscribe();
		unsubscribeSubagents();
		const usage = { ...meter.update() };
		opts.onUsage(usage);
		transcript({ type: "run_end", usage, ...(aborted ? { aborted } : {}), ...(runError ? { error: runError } : {}) });
		await session.dispose();
	}
}

/** Text blocks of a tool result (images and structured details are left out of the log). */
function toolResultText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	const texts: string[] = [];
	for (const block of result.content) {
		if (block && typeof block === "object" && "text" in block && typeof block.text === "string") texts.push(block.text);
	}
	return texts.join("\n");
}
