import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

/**
 * AGT-25: the rules a task agent's frontmatter must satisfy. The orchestrator refuses uploads that break them and lists
 * stored entries that do as broken; the worker leaves such agents out of a session (AGT-31). `tools` is read the way omp
 * reads it (a YAML list or a comma-separated string, built-in names normalised), so what is checked is what omp loads.
 */

/** Skill and agent names; also the path-traversal guard for every path built from a name. */
export const ASSET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** omp uses these names for the top-level session and unnamed subagents. */
export const RESERVED_AGENT_NAMES: readonly string[] = ["main", "sub"];

/** The only tools a subagent may be given (AGT-25). */
export const SUBAGENT_TOOLS: readonly string[] = ["web_search"];

const ALLOWED = `allowed: ${SUBAGENT_TOOLS.join(", ")}`;

/** Frontmatter keys that attach another model loop with its own tools to the subagent (spike A2). */
const LOOP_KEYS = ["advisor", "prewalk"] as const;

/** Why `name` and `description` are unusable for an agent or skill; undefined when they are fine. */
export function nameProblem(name: unknown, description: unknown): string | undefined {
	if (typeof name !== "string" || typeof description !== "string" || !description.trim()) return 'frontmatter needs a string "name" and a non-empty "description".';
	if (!ASSET_NAME_RE.test(name)) return `name "${name}" must be 1–64 lowercase letters, digits or hyphens, starting with a letter or digit.`;
	return undefined;
}

/** Why an agent's frontmatter breaks AGT-25; undefined when omp may load it as a subagent. */
export function agentProblem(frontmatter: Record<string, unknown>): string | undefined {
	const named = nameProblem(frontmatter.name, frontmatter.description);
	if (named) return named;
	if (RESERVED_AGENT_NAMES.includes(frontmatter.name as string)) return `"${RESERVED_AGENT_NAMES.join('" and "')}" are reserved agent names.`;
	if (Object.hasOwn(frontmatter, "spawns")) return '"spawns" is not allowed: subagents cannot spawn subagents.';
	for (const key of LOOP_KEYS) {
		if (Object.hasOwn(frontmatter, key)) return `"${key}" is not allowed: it attaches another model loop with its own tools to the subagent.`;
	}
	if (frontmatter.tools == null) return `"tools" is required (${ALLOWED}).`;
	const tools = parseAgentFields(frontmatter)?.tools ?? [];
	if (!tools.length) return `"tools" must name at least one tool (${ALLOWED}).`;
	if (tools.includes("task")) return '"task" is not allowed in "tools": subagents cannot spawn subagents.';
	const refused = tools.filter(tool => !SUBAGENT_TOOLS.includes(tool));
	if (refused.length) return `"tools" may not include ${refused.join(", ")} (${ALLOWED}).`;
	return undefined;
}
