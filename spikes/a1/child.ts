/**
 * Spike A1 agent process. run.ts starts it with HOME, PI_CODING_AGENT_DIR and cwd inside a sandbox (as the worker
 * starts the agent host, spike S2), plus A1_* variables naming the sandbox parts and the developer's real omp dir
 * (sign-ins only).
 *
 * A1_MODE=discover: AgentBot's session options as they are (skills discovered by omp; omp dir as the only extension
 *   root). Creates the session, prints what omp found, no model call.
 * A1_MODE=explicit: the same plus `skills:` loaded from <ompDir>/skills only; direct tool checks, then one real turn.
 */
import { join } from "node:path";
import {
	AgentRegistry,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { calls, createAskTools, resolveToolPath } from "./skillTools";

function env(k: string): string {
	const v = process.env[k];
	if (!v) throw new Error(`${k} not set`);
	return v;
}
const mode = env("A1_MODE");
const sandbox = env("A1_SANDBOX");
const ompDir = env("A1_OMP_DIR");
const scratch = env("A1_SCRATCH");
const agentDir = env("PI_CODING_AGENT_DIR");
const realAgentDir = env("A1_REAL_AGENT_DIR");
const modelPattern = process.env.A1_MODEL ?? "anthropic/claude-haiku-4-5";
function out(msg: string, data?: unknown): void {
	console.log(data === undefined ? msg : `${msg} ${typeof data === "string" ? data : JSON.stringify(data)}`);
}
const checks: Record<string, boolean> = {};
const roots = { scratch, skills: join(ompDir, "skills") };

// --- 1. Direct tool checks (no model) ---
if (mode === "explicit") {
	const tools = createAskTools(roots);
	const direct: [string, string, Record<string, unknown>, boolean][] = [
		["read skill://glossary", "read_file", { path: "skill://glossary" }, true],
		["read skill://glossary/", "read_file", { path: "skill://glossary/" }, true],
		["read skill://glossary/terms.md", "read_file", { path: "skill://glossary/terms.md" }, true],
		["list skill://glossary", "list_files", { path: "skill://glossary" }, true],
		["read skill://glossary/../../../secret.txt", "read_file", { path: "skill://glossary/../../../secret.txt" }, false],
		["read skill://glossary/../other/SKILL.md (sibling skill)", "read_file", { path: "skill://glossary/../other/SKILL.md" }, false],
		["read skill://glossary/leak.md (symlink to ../../secret.txt)", "read_file", { path: "skill://glossary/leak.md" }, false],
		["read skill://glossary//etc/hosts", "read_file", { path: "skill://glossary//etc/hosts" }, false],
		["read skill://..", "read_file", { path: "skill://.." }, false],
		["read skill://decoy-user (not in the omp dir)", "read_file", { path: "skill://decoy-user" }, false],
		["write skill://glossary/x.md", "write_file", { path: "skill://glossary/x.md", content: "x" }, false],
		["read file:///etc/hosts", "read_file", { path: "file:///etc/hosts" }, false],
	];
	for (const [label, name, params, expectOk] of direct) {
		let ok = true;
		let text: string;
		try {
			const r = await tools.find(t => t.name === name)!.execute("t", params as never, undefined, undefined as never, undefined);
			text = r.content.map(c => (c.type === "text" ? c.text : "")).join("");
		} catch (err) {
			ok = false;
			text = (err as Error).message;
		}
		out(`direct ${label}: ${ok ? "ok" : "refused"} — ${text.split("\n")[0]}`);
		checks[`direct: ${label}`] = ok === expectOk;
	}
	out("skill://glossary resolves to", (await resolveToolPath(roots, "skill://glossary")).abs);
	calls.length = 0;
}

// --- 2. A restricted session ---
const authStorage = await discoverAuthStorage(realAgentDir);
const modelRegistry = new ModelRegistry(authStorage, join(realAgentDir, "models.yml"));
// AskBot's initRunSettings: in-memory, admin overrides then the pinned values (AGT-20).
const settings = await Settings.init({
	inMemory: true,
	agentDir,
	cwd: agentDir,
	overrides: { "compaction.enabled": true, "retry.enabled": true, "tools.approvalMode": "yolo", "ask.timeout": 0, "async.enabled": false },
});
const toolNames = ["web_search", "list_files", "read_file", "write_file", "yield"];
const options: CreateAgentSessionOptions = {
	cwd: scratch,
	agentDir,
	authStorage,
	modelRegistry,
	sessionManager: SessionManager.create(scratch, join(sandbox, "sessions")),
	settings,
	agentRegistry: new AgentRegistry(),
	hasUI: false,
	interactivePrompts: false,
	enableMCP: false,
	disableExtensionDiscovery: true,
	additionalExtensionPaths: [ompDir],
	modelPattern,
	thinkingLevel: "off",
	outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
	outputSchemaMode: "strict",
	requireYieldTool: true,
	customTools: createAskTools(roots),
	allowRestrictedCustomTools: true,
	toolNames,
	restrictToolNames: true,
};
if (mode === "explicit") {
	// The fix: the skill list comes from the omp dir only, so omp's own discovery never runs (sdk.ts:1883-1890).
	const loaded = await loadSkillsFromDir({ dir: join(ompDir, "skills"), source: "askbot:user" });
	out("loadSkillsFromDir warnings", loaded.warnings);
	options.skills = loaded.skills;
}
const { session } = await createAgentSession(options);

const active = session.getActiveToolNames();
out("active tools", active);
out("enabled tools", session.getEnabledToolNames());
checks["active tools are exactly the ask profile"] = [...active].sort().join() === [...toolNames].sort().join();
const skills = session.skills.map(s => ({ name: s.name, source: s.source, filePath: s.filePath.replace(sandbox, "<sandbox>") }));
out("session.skills", skills);
const systemPrompt = session.systemPrompt.join("\n");
await Bun.write(join(import.meta.dir, "out", `system-prompt.${mode}.txt`), systemPrompt.replaceAll(sandbox, "<sandbox>"));
const skillSection = systemPrompt.match(/# Skills & Rules[\s\S]*?<\/skills>/)?.[0];
out(`system prompt (${systemPrompt.length} chars) skills section:\n${skillSection ?? "(none)"}`);
const uriDoc = systemPrompt.split("\n").find(l => l.includes("skill://<name>`:"));
out("system prompt skill:// doc line:", uriDoc ?? "(none)");

if (mode === "discover") {
	// Expected: omp's discovery adds skills from places other than the omp dir (the hazard this mode documents).
	checks["omp discovery leaks skills from outside the omp dir"] = skills.some(s => s.name.startsWith("decoy-"));
} else {
	checks["session.skills are exactly the omp dir's skills"] = skills.map(s => s.name).join() === "glossary,other" && skills.every(s => s.filePath.startsWith("<sandbox>/omp/skills/"));
	checks["system prompt lists glossary"] = !!skillSection?.includes("- glossary:");
	checks["system prompt documents skill://"] = !!uriDoc;
	checks["no decoy skill in system prompt"] = !/decoy/i.test(systemPrompt);

	const events: string[] = [];
	let answer: unknown;
	session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start") events.push(`tool_start ${event.toolName} ${JSON.stringify(event.args)}`);
		if (event.type === "tool_execution_end") {
			const result = event.result as { content?: { type: string; text?: string }[]; details?: { data?: unknown } } | undefined;
			const text = (result?.content ?? []).map(c => c.text ?? "").join("").replace(/\n/g, "⏎");
			events.push(`tool_end ${event.toolName} isError=${!!event.isError} ${text.slice(0, 140)}`);
			if (event.toolName === "yield" && !event.isError) answer = result?.details?.data;
		}
	});
	// The prompt names no skill and no URI: the system prompt's catalog must lead the agent there.
	await session.prompt('What does the team term "flarn" mean, and what is its code word? Answer in one sentence.');
	await session.waitForIdle();
	for (const e of events) out(e);
	out("raw path arguments seen by the custom tools' execute", calls);
	out("answer", answer);
	const { cost, tokens } = session.getSessionStats();
	out("usage", { cost, tokens });
	checks["agent read skill://glossary (raw URI reached execute)"] = calls.some(c => c.tool === "read_file" && /^skill:\/\/glossary\/?$/.test(c.path ?? "") && c.ok);
	checks["agent read the extra skill file"] = calls.some(c => c.tool === "read_file" && c.path === "skill://glossary/terms.md" && c.ok);
	checks["answer has the code word"] = /ZEBRA-42/.test(JSON.stringify(answer ?? ""));
	checks["no omp read/bash call"] = !events.some(e => /^tool_start (read|bash) /.test(e));
}
await session.dispose();

out(`checks (${mode})`, checks);
const pass = Object.values(checks).every(Boolean);
out(`A1 ${mode}: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
