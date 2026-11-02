import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { captureLoadout } from "../../src/worker/host/loadout";

/** Just the members captureLoadout reads from a real AgentSession. */
function fakeSession(tools: string[]): AgentSession {
	const session = {
		getActiveToolNames: () => tools,
		skills: [{ name: "glossary", source: "askbot:user", description: "terms", filePath: "/x", baseDir: "/x" }],
	};
	return session as unknown as AgentSession;
}

const agents = [
	{ name: "researcher", description: "Searches" },
	{ name: "writer", description: "Writes" },
];

test("sessions without task report their tools and skills but no agents", async () => {
	const loadout = await captureLoadout(fakeSession(["yield", "web_search", "read_file"]), { agents, profile: "ask" });
	expect(loadout.tools).toEqual(["read_file", "web_search", "yield"]);
	expect(loadout.skills).toEqual([{ name: "glossary", source: "askbot:user", description: "terms" }]);
	expect(loadout.agents).toEqual([]);
});

test("sessions with a task tool list the valid agents minus disabled ones, never omp's bundled agents", async () => {
	const loadout = await captureLoadout(fakeSession(["task", "read_file"]), { agents, profile: "ask", disabledAgents: ["writer", "sonic"] });
	expect(loadout.agents).toEqual([{ name: "researcher", source: "askbot:user", description: "Searches" }]);
});
