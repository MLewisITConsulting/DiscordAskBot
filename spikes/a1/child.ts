/**
 * Spike A1 agent process. run.ts starts it with HOME, PI_CODING_AGENT_DIR and cwd inside a sandbox (as the worker
 * starts the agent host, spike S2), plus A1_* variables naming the sandbox parts and the developer's real omp dir
 * (sign-ins only).
 */
import { join } from "node:path";
import {
	AgentRegistry,
	type AgentSessionEvent,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { calls, createAskTools, resolveToolPath } from "./skillTools";

const env = (k: string) => {
	const v = process.env[k];
	if (!v) throw new Error(`${k} not set`);
	return v;
};
const sandbox = env("A1_SANDBOX");
const ompDir = env("A1_OMP_DIR");
const scratch = env("A1_SCRATCH");
const agentDir = env("PI_CODING_AGENT_DIR");
const realAgentDir = env("A1_REAL_AGENT_DIR");
const modelPattern = process.env.A1_MODEL ?? "anthropic/claude-haiku-4-5";
const out = (msg: string, data?: unknown) => console.log(data === undefined ? msg : `${msg} ${typeof data === "string" ? data : JSON.stringify(data)}`);
const checks: Record<string, boolean> = {};

// Outbound requests, to see whether omp makes model calls of its own (skill description compression).
const realFetch = globalThis.fetch;
const fetches: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	fetches.push(`${init?.method ?? "GET"} ${new URL(url).host}${new URL(url).pathname}`);
	return realFetch(input, init);
}) as typeof fetch;

// --- 1. Direct tool checks (no model) ---
const roots = { scratch, skills: join(ompDir, "skills") };
const tools = createAskTools(roots);
const tool = (name: string) => tools.find(t => t.name === name)!;
const run = async (name: string, params: Record<string, unknown>) => {
	try {
		const r = (await tool(name).execute("t", params as never, undefined, undefined as never, undefined)) as { content: { text: string }[] };
		return { ok: true, text: r.content[0]!.text };
	} catch (err) {
		return { ok: false, text: (err as Error).message };
	}
};
const direct: [string, string, Record<string, unknown>, boolean][] = [
	["read skill://glossary", "read_file", { path: "skill://glossary" }, true],
	["read skill://glossary/terms.md", "read_file", { path: "skill://glossary/terms.md" }, true],
	["list skill://glossary", "list_files", { path: "skill://glossary" }, true],
	["read skill://glossary/../../../secret.txt", "read_file", { path: "skill://glossary/../../../secret.txt" }, false],
	["read skill://glossary/../decoy/SKILL.md (sibling)", "read_file", { path: "skill://glossary/../other/SKILL.md" }, false],
	["read skill://glossary/leak.md (symlink)", "read_file", { path: "skill://glossary/leak.md" }, false],
	["read skill://glossary//etc/hosts", "read_file", { path: "skill://glossary//etc/hosts" }, false],
	["read skill://..", "read_file", { path: "skill://.." }, false],
	["read skill://decoy-user (not in root)", "read_file", { path: "skill://decoy-user" }, false],
	["write skill://glossary/x.md", "write_file", { path: "skill://glossary/x.md", content: "x" }, false],
	["read file:///etc/hosts", "read_file", { path: "file:///etc/hosts" }, false],
];
for (const [label, name, params, expectOk] of direct) {
	const r = await run(name, params);
	out(`direct ${label}: ${r.ok ? "ok" : "refused"} — ${r.text.split("\n")[0]}`);
	checks[`direct: ${label}`] = r.ok === expectOk;
}
await resolveToolPath(roots, "skill://glossary").then(r => out("skill://glossary resolves to", r.abs));
calls.length = 0;

// --- 2. A real restricted session ---
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
const { session } = await createAgentSession({
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
});

const active = session.getActiveToolNames();
const enabled = session.getEnabledToolNames();
out("active tools", active);
out("enabled tools", enabled);
checks["active tools are exactly the ask profile"] = [...active].sort().join() === [...toolNames].sort().join();
const skills = session.skills.map(s => ({ name: s.name, source: s.source, filePath: s.filePath }));
out("session.skills", skills);
checks["session.skills is exactly [glossary] from the omp dir"] = skills.length === 1 && skills[0]!.name === "glossary" && skills[0]!.filePath.startsWith(ompDir);

const systemPrompt = session.systemPrompt.join("\n");
await Bun.write(join(import.meta.dir, "out", "system-prompt.txt"), systemPrompt);
const skillSection = systemPrompt.match(/# Skills & Rules[\s\S]*?<\/skills>/)?.[0];
out(`system prompt (${systemPrompt.length} chars) skills section:\n${skillSection ?? "(none)"}`);
const uriDoc = systemPrompt.split("\n").find(l => l.includes("skill://<name>`:"));
out("system prompt skill:// doc line:", uriDoc ?? "(none)");
checks["system prompt lists glossary"] = !!skillSection?.includes("- glossary:");
checks["system prompt documents skill://"] = !!uriDoc;
checks["no decoy skill in system prompt"] = !/decoy/i.test(systemPrompt);
const fetchesBeforePrompt = fetches.length;

const events: string[] = [];
let answer: unknown;
session.subscribe((event: AgentSessionEvent) => {
	if (event.type === "tool_execution_start") events.push(`tool_start ${event.toolName} ${JSON.stringify(event.args)}`);
	if (event.type === "tool_execution_end") {
		const text = ((event.result as { content?: { type: string; text?: string }[] })?.content ?? []).map(c => c.text ?? "").join("").replace(/\n/g, "⏎");
		events.push(`tool_end ${event.toolName} isError=${!!event.isError} ${text.slice(0, 160)}`);
		if (event.toolName === "yield" && !event.isError) answer = (event.result as { details?: { data?: unknown } }).details?.data;
	}
});
await session.prompt("What does the team term \"flarn\" mean, and what is its code word? Answer in one sentence.");
await session.waitForIdle();
for (const e of events) out(e);
out("raw path arguments seen by the custom tools", calls);
out("answer", answer);
out("outbound requests (before prompt / total)", { beforePrompt: fetches.slice(0, fetchesBeforePrompt), all: fetches });
checks["agent read skill://glossary (raw URI reached execute)"] = calls.some(c => c.tool === "read_file" && /^skill:\/\/glossary\/?$/.test(c.path ?? "") && c.ok);
checks["agent read the extra skill file"] = calls.some(c => c.tool === "read_file" && c.path === "skill://glossary/terms.md" && c.ok);
checks["answer has the definition and code word"] = /ZEBRA-42/.test(JSON.stringify(answer ?? ""));
checks["no omp skill reader leaked in (read/bash)"] = !events.some(e => /^tool_start (read|bash) /.test(e));
const { cost, tokens } = session.getSessionStats();
out("usage", { cost, tokens });
await session.dispose();

out("checks", checks);
const pass = Object.values(checks).every(Boolean);
out(`A1 RESULT: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
