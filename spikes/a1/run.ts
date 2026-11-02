/**
 * Spike A1: `bun spikes/a1/run.ts`. Builds a sandbox with the admin's omp dir (one skill, `glossary`), decoy skills in
 * every place omp would discover them (fake HOME, agent dir, project dirs in the cwd), and a secret outside every root.
 * Starts child.ts with HOME / PI_CODING_AGENT_DIR in the sandbox, the scratch dir as cwd, and the developer's real
 * omp dir only for sign-ins. Deletes the sandbox afterwards.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "askbot-a1-"));
const home = join(sandbox, "home");
const agentDir = join(sandbox, "agent");
const ompDir = join(sandbox, "omp");
const scratch = join(sandbox, "scratch");

async function put(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}
const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const decoy = (name: string) => skill(name, `DECOY skill ${name}; must not be visible.`, "# Decoy");

await put(
	join(ompDir, "skills/glossary/SKILL.md"),
	skill(
		"glossary",
		"Definitions of the team's internal jargon. Use when a question mentions an unfamiliar team term.",
		"# Team glossary\n\nThe definitions are in `terms.md` in this skill's folder. Read it and quote the definition and code word exactly.",
	),
);
await put(join(ompDir, "skills/glossary/terms.md"), "# Terms\n\n- **flarn**: a seven-minute standup held standing on one foot. Code word: ZEBRA-42.\n- **quibbet**: a pull request with exactly one changed line. Code word: OTTER-7.\n");
await put(join(ompDir, "skills/other/SKILL.md"), skill("other", "Second admin skill, used only as a sibling target for confinement checks.", "# Other"));
await mkdir(join(ompDir, "agents"), { recursive: true });
await put(join(sandbox, "secret.txt"), "TOP SECRET\n");
await symlink(join(sandbox, "secret.txt"), join(ompDir, "skills/glossary/leak.md"));

// Decoys where omp's skill discovery looks by default (user and project level, omp/claude/agents/codex).
for (const [dir, name] of [
	[join(home, ".omp/agent/skills"), "decoy-user"],
	[join(agentDir, "skills"), "decoy-agentdir"],
	[join(home, ".claude/skills"), "decoy-claude-user"],
	[join(home, ".agents/skills"), "decoy-agents-user"],
	[join(home, ".codex/skills"), "decoy-codex-user"],
	[join(scratch, ".omp/skills"), "decoy-project"],
	[join(scratch, ".claude/skills"), "decoy-claude-project"],
	[join(scratch, ".agents/skills"), "decoy-agents-project"],
] as const)
	await put(join(dir, name, "SKILL.md"), decoy(name));
await mkdir(join(scratch, "inputs"), { recursive: true });
await mkdir(join(scratch, "outputs"), { recursive: true });

// Drop the developer's omp variables so nothing points back at ~/.omp.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|OMP_)/.test(k)) env[k] = v;
Object.assign(env, {
	HOME: home,
	PI_CODING_AGENT_DIR: agentDir,
	A1_SANDBOX: sandbox,
	A1_OMP_DIR: ompDir,
	A1_SCRATCH: scratch,
	A1_REAL_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"),
});
const proc = Bun.spawn(["bun", join(import.meta.dir, "child.ts")], { cwd: scratch, env, stdout: "inherit", stderr: "inherit" });
const code = await proc.exited;
await rm(sandbox, { recursive: true, force: true });
process.exit(code);
