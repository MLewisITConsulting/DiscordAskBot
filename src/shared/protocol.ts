import type { AgentProfile, Loadout } from "./agent";
import type { OmpConfig } from "./ompconfig";
import type { RunUsage, TranscriptEvent } from "./transcript";

/**
 * Messages between the worker supervisor and its agent host (`src/worker/host/host.ts`), one host process per run, over
 * Bun's JSON IPC channel (ported from DevForge `src/agent/protocol.ts`). The supervisor relays every message except
 * `start` and `credential_request` to the orchestrator unchanged (architecture §4.2): `ChildMessage`s go up as relay
 * messages, `ParentMessage`s from the orchestrator come down. Requests carry a numeric `id` that the matching `reply`
 * echoes; ids are allocated by whoever sends the request.
 */

/** Where the host finds what the worker downloaded, and the run's keys (architecture §2.3, S2). */
export interface HostRuntime {
	/** omp agent dir with the run-private auth store (`PI_CODING_AGENT_DIR`, CRED-02); run-local, mode 0700. */
	agentDir: string;
	/** The downloaded skills and agents: the session's only extension root (AGT-24). */
	ompDir: string;
	providerKeys: Record<string, string>;
}

export interface StartOptions {
	runId: string;
	/** Working directory: a run directory outside the scratch copy, with no `.omp` in or above it (AGT-24). */
	cwd: string;
	/** Directory the session file is written in. */
	sessionDir: string;
	/** Session file to resume, when the run continues one (CHAT-03). */
	resumeFile?: string;
	profile: AgentProfile;
	modelPattern?: string;
	thinking: string;
	/** Complete prompt, built by the orchestrator. */
	prompt: string;
	outputSchema?: object;
	limits: { minutes: number; costUsd: number };
	omp: OmpConfig;
	wantLoadout: boolean;
	/** The scratch root the file tools are confined to (AGT-28). */
	scratchRoot: string;
}

export type Reply = { t: "reply"; id: number } & ({ ok: true; value?: unknown } | { ok: false; error: string; aborted?: boolean });

export interface HostResult {
	output?: unknown;
	/** Path of the session file inside the worker (uploaded by the supervisor, RUN-19). */
	sessionFile: string;
	usage: RunUsage;
	aborted?: "time" | "cost" | "user";
	oomKills: number;
}

export type ParentMessage =
	/** Built by the supervisor from the run spec; never relayed. */
	| { t: "start"; runtime: HostRuntime; opts: StartOptions }
	| { t: "steer"; id: number; text: string }
	| { t: "abort"; id: number; reason: "user" | "time" | "cost" }
	/** Answers `session_file` and `credential_request`. */
	| Reply;

export type ChildMessage =
	| { t: "progress"; tool?: string; intent?: string; usage: RunUsage; elapsedMs: number }
	| { t: "transcript"; event: TranscriptEvent }
	| { t: "loadout"; loadout: Loadout }
	| { t: "usage"; usage: RunUsage }
	/** Sent before the prompt; the session waits for the reply so a restart can always resume it (RUN-18). */
	| { t: "session_file"; id: number; path: string }
	/** The session accepts `steer` and `abort` from now on. */
	| { t: "registered" }
	/**
	 * omp's `refreshOAuthCredential` hook fired (S1, CRED-03). Handled by the supervisor as the `credential-request`
	 * control message; never relayed. The reply's value is `{ accessToken, expiresAt }`; a refusal is `ok: false`.
	 */
	| { t: "credential_request"; id: number; provider: string; credentialId: string; accessToken?: string }
	/** Answers `steer` and `abort`. */
	| Reply
	/** A log line, already cut to 8 KiB by the supervisor before relaying (RUN-16). */
	| { t: "log"; line: string }
	| { t: "done"; result: HostResult }
	| { t: "failed"; message: string; name: string };
