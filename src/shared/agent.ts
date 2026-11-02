/** Agent types shared by the orchestrator (rendering, status) and the worker (agent host). No omp or Discord imports. */

/** The one tool profile (AGT-08). */
export type AgentProfile = "ask";

/** What a session loaded (AGT-27). */
export interface Loadout {
	capturedAt: string;
	profile: AgentProfile;
	/** Top-level tools the session exposed. */
	tools: string[];
	skills: { name: string; source: string; description: string }[];
	/** Agents the `task` tool could run; empty when `task` is not active. */
	agents: { name: string; source: string; description: string }[];
}
