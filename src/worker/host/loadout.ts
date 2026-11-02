import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentProfile, Loadout } from "../../shared/agent";
import type { ValidAgent } from "./agents";

/**
 * What one agent session actually had loaded when it started (AGT-27). The agents are the session's `spawns` allowlist
 * (the worker's valid agents, AGT-31), not omp's discovery, which also lists its bundled agents (spike A2).
 */
export async function captureLoadout(
	session: Pick<AgentSession, "getActiveToolNames" | "skills">,
	opts: { agents: readonly ValidAgent[]; profile: AgentProfile; disabledAgents?: readonly string[] },
): Promise<Loadout> {
	const tools = session.getActiveToolNames().sort();
	const skills = session.skills
		.map(skill => ({ name: skill.name, source: skill.source, description: skill.description }))
		.sort((a, b) => a.name.localeCompare(b.name));

	let agents: Loadout["agents"] = [];
	if (tools.includes("task")) {
		const disabled = opts.disabledAgents ?? [];
		agents = opts.agents
			.filter(agent => !disabled.includes(agent.name))
			.map(agent => ({ name: agent.name, source: "askbot:user", description: agent.description }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	return { capturedAt: new Date().toISOString(), profile: opts.profile, tools, skills, agents };
}
