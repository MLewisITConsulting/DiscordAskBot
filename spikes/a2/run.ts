/**
 * Spike A2 (wiki/implementation.md §3): can omp's `task` tool in a restricted `ask` session spawn only the admin's
 * agents, give the child only its frontmatter tools, keep omp's bundled agents and agents from anywhere else out,
 * stop subagents from spawning, count child usage in the parent, and abort the child with the parent?
 *
 *   bun spikes/a2/run.ts
 *
 * Makes a sandbox (run-local HOME and PI_CODING_AGENT_DIR, like a worker), seeds agents in every place omp looks,
 * then starts `spike.ts` in a child process with that environment: omp (and Bun's `os.homedir()`) read it at load,
 * as in a worker's agent host (S2). Sign-ins come from the developer's omp store (`~/.omp/agent`, or `A2_AUTH_DIR`);
 * the model is `A2_MODEL` (default anthropic/claude-haiku-5-5). The sandbox is removed afterwards.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const authDir = process.env.A2_AUTH_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
const root = await mkdtemp(join(tmpdir(), "askbot-a2-"));
const home = join(root, "home");
const agentDir = join(home, ".omp", "agent");
// The thread's scratch copy (write_file writes here) and the proposed session cwd (nothing the model can write).
const scratch = join(root, "scratch");
const work = join(root, "work");
const ompDir = join(root, "omp");

const agentFile = (name: string, description: string, extra: string, body: string) =>
	`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;

async function put(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

// The admin's agents: the session's only extension root (AGT-24).
await put(
	join(ompDir, "agents", "researcher.md"),
	agentFile(
		"researcher",
		"Looks things up on the web and reports back in two sentences.",
		"tools: web_search\n",
		"You are a research assistant. Always call web_search before answering, even if you think you know. Answer in at most two sentences.",
	),
);
// Invalid under AGT-25 (bash is outside the allowlist); the worker must drop it. Here it stays, to see what omp does.
await put(
	join(ompDir, "agents", "shell.md"),
	agentFile("shell", "Runs shell commands.", "tools: bash\n", "You run shell commands when asked. Reply with the command output only."),
);
// Invalid under AGT-25 (`spawns`); used only to show the depth pin strips `task` from children.
await put(
	join(ompDir, "agents", "spawner.md"),
	agentFile("spawner", "Delegates to researcher.", "tools: web_search\nspawns: researcher\n", "Reply with the single word: done."),
);
// Agents in the other places omp discovers from: user level and project level. Neither may be spawnable (AGT-31).
await put(
	join(agentDir, "agents", "user-rogue.md"),
	agentFile("user-rogue", "User-level agent that must not be spawnable.", "tools: bash\n", "Run bash."),
);
await put(
	join(scratch, ".omp", "agents", "project-rogue.md"),
	agentFile("project-rogue", "Project-level agent that must not be spawnable.", "tools: bash\n", "Run bash."),
);
await mkdir(join(scratch, "inputs"), { recursive: true });
await mkdir(join(scratch, "outputs"), { recursive: true });
await mkdir(work, { recursive: true });

const paths = { authDir, agentDir, scratch, work, ompDir, model: process.env.A2_MODEL || "anthropic/claude-haiku-5-5" };
let code = 2;
try {
	const proc = Bun.spawn([process.execPath, join(import.meta.dir, "spike.ts")], {
		cwd: work,
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, A2_PATHS: JSON.stringify(paths) },
		stdout: "inherit",
		stderr: "inherit",
	});
	code = await proc.exited;
} finally {
	await rm(root, { recursive: true, force: true });
}
console.log(`A2 RESULT: ${code === 0 ? "all checks as expected" : `exit ${code}`}`);
process.exit(code);
