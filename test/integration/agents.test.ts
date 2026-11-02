import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildMessage } from "../../src/shared/protocol";
import type { TranscriptEvent } from "../../src/shared/transcript";
import {
	type HostDirs,
	type HostRunOptions,
	makeHostDirs,
	type ModelRequest,
	type ModelTurn,
	removeHostDirs,
	runRealHost,
	startFakeModel,
	writeFakeModels,
} from "../fixtures/real-host";

/**
 * The real agent host with omp's own `task` tool against a fake model (no real model call): the worker's agent check
 * (AGT-31), `task` only with a valid agent (AGT-08), the `spawns` allowlist and the child's tools (spike A2), the
 * loadout (AGT-27) and the cost limit while a subagent runs (AGT-32). Parent and child share the fake model; a child's
 * requests are told apart by the tools they offer.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
	await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
}, 30_000);

const ANSWER_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
const yieldAnswer = (answer: string): ModelTurn => ({ toolCalls: [{ name: "yield", args: { data: { answer } } }] });
const spawn = (agent: string): ModelTurn => ({
	toolCalls: [{ name: "task", args: { context: "Test.", tasks: [{ agent, task: "Say done.", solutionSpace: "trivial" }] } }],
	usage: { input: 0, output: 0 },
});
const isChild = (req: ModelRequest) => !req.tools.includes("yield");

function agentFile(dirs: HostDirs, file: string, frontmatter: string): void {
	mkdirSync(join(dirs.omp, "agents"), { recursive: true });
	writeFileSync(join(dirs.omp, "agents", file), `---\n${frontmatter}\n---\nYou help.\n`);
}

/** The admin's valid agent plus invalid and misnamed ones. */
function installAgents(dirs: HostDirs): void {
	agentFile(dirs, "researcher.md", "name: researcher\ndescription: Searches the web.\ntools: web_search");
	agentFile(dirs, "shell.md", "name: shell\ndescription: Runs commands.\ntools: bash");
	agentFile(dirs, "advised.md", "name: advised\ndescription: Has an advisor.\ntools: web_search\nadvisor: true");
	agentFile(dirs, "alias.md", "name: helper\ndescription: Misnamed file.\ntools: web_search");
}

async function setup(play: (n: number, req: ModelRequest) => ModelTurn, costPerMTok = 0) {
	const model = startFakeModel(play);
	cleanups.push(() => model.stop());
	const dirs = await makeHostDirs();
	cleanups.push(() => removeHostDirs(dirs));
	await writeFakeModels(dirs, model, { costPerMTok, apiKey: "fake-key" });
	return { model, dirs };
}

async function host(o: HostRunOptions) {
	const run = runRealHost(o);
	cleanups.push(() => {
		run.proc.kill("SIGKILL");
	});
	return { run, end: await run.end };
}

const transcriptOf = (messages: ChildMessage[]): TranscriptEvent[] => messages.flatMap(m => (m.t === "transcript" ? [m.event] : []));
const logsOf = (messages: ChildMessage[]) => messages.flatMap(m => (m.t === "log" ? [JSON.parse(m.line) as Record<string, unknown>] : []));

describe("task agents in /ask (AGT-08, AGT-31)", () => {
	test.concurrent("invalid and misnamed agents are deleted and logged; only valid agents are spawnable, with their own tools", async () => {
		let parent = 0;
		const { model, dirs } = await setup((_n, req) => {
			if (isChild(req)) return { text: "child-done" };
			const turns = [spawn("shell"), spawn("scout"), spawn("researcher"), yieldAnswer("ok")];
			return turns[parent++] ?? yieldAnswer("ok");
		});
		installAgents(dirs);
		// A project agent the model could plant in its scratch dir: never found, the cwd is elsewhere (spike A2).
		mkdirSync(join(dirs.scratch, ".omp", "agents"), { recursive: true });
		writeFileSync(join(dirs.scratch, ".omp", "agents", "researcher.md"), "---\nname: researcher\ndescription: Rogue.\ntools: bash, read\n---\nRogue.\n");
		const { run, end } = await host({ dirs, opts: { prompt: "hi", outputSchema: ANSWER_SCHEMA, wantLoadout: true } });
		expect(end).toMatchObject({ t: "done", result: { output: { answer: "ok" } } });

		expect(readdirSync(join(dirs.omp, "agents"))).toEqual(["researcher.md"]);
		const skipped = logsOf(run.messages).filter(l => l.msg === "agent skipped");
		expect(skipped.map(l => l.name).sort()).toEqual(["advised", "helper", "shell"]);
		expect(skipped.every(l => typeof l.reason === "string" && l.reason.length > 0)).toBe(true);

		const loadout = run.messages.find(m => m.t === "loadout");
		expect(loadout?.t === "loadout" && loadout.loadout).toMatchObject({
			tools: ["list_files", "read_file", "task", "web_search", "write_file", "yield"],
			agents: [{ name: "researcher", source: "askbot:user", description: "Searches the web." }],
		});
		expect(model.requests[0]!.tools).toEqual(["list_files", "read_file", "task", "web_search", "write_file", "yield"]);

		const taskEnds = transcriptOf(run.messages).filter(e => e.type === "tool_end" && e.tool === "task");
		expect(taskEnds).toHaveLength(3);
		// The invalid admin agent and omp's bundled agents are refused at preflight, before any child exists.
		expect(taskEnds[0]).toMatchObject({ isError: true, text: expect.stringContaining("Cannot spawn 'shell'. Allowed: researcher") });
		expect(taskEnds[1]).toMatchObject({ isError: true, text: expect.stringContaining("Cannot spawn 'scout'. Allowed: researcher") });
		expect(taskEnds[2]).toMatchObject({ text: expect.stringContaining("child-done") });
		// The child got exactly its frontmatter tools, not the planted copy's.
		const children = model.requests.filter(isChild);
		expect(children).toHaveLength(1);
		expect(children[0]!.tools).toEqual(["web_search"]);
	}, 60_000);

	test.concurrent("with no valid agent there is no task tool", async () => {
		const { model, dirs } = await setup(() => yieldAnswer("ok"));
		agentFile(dirs, "shell.md", "name: shell\ndescription: Runs commands.\ntools: bash");
		const { run, end } = await host({ dirs, opts: { prompt: "hi", outputSchema: ANSWER_SCHEMA, wantLoadout: true } });
		expect(end).toMatchObject({ t: "done" });
		expect(model.requests[0]!.tools).toEqual(["list_files", "read_file", "web_search", "write_file", "yield"]);
		const loadout = run.messages.find(m => m.t === "loadout");
		expect(loadout?.t === "loadout" && loadout.loadout.agents).toEqual([]);
		expect(existsSync(join(dirs.omp, "agents", "shell.md"))).toBe(false);
	}, 60_000);
});

describe("subagent limits and usage (AGT-32)", () => {
	test.concurrent("a subagent's cost is checked while it runs: the turn is aborted with `cost` and the child stops", async () => {
		// $1 per token. The child's first reply costs $10 against a $1 limit and asks to go on (a tool it does not have).
		const { model, dirs } = await setup((_n, req) =>
			isChild(req) ? { toolCalls: [{ name: "nothing", args: {} }], usage: { input: 6, output: 4 } } : spawn("researcher"), 1_000_000);
		agentFile(dirs, "researcher.md", "name: researcher\ndescription: Searches the web.\ntools: web_search");
		const { end } = await host({ dirs, opts: { prompt: "spend", outputSchema: ANSWER_SCHEMA, limits: { minutes: 10, costUsd: 1 } } });
		expect(end).toMatchObject({ t: "done", result: { aborted: "cost" } });
		// One parent call, one child call: nothing after the abort.
		expect(model.requests.map(isChild)).toEqual([false, true]);
	}, 60_000);

	test.concurrent("a subagent's usage counts toward the turn's usage", async () => {
		let parent = 0;
		const { dirs } = await setup((_n, req) => {
			if (isChild(req)) return { text: "child-done", usage: { input: 30, output: 20 } };
			return parent++ === 0 ? { ...spawn("researcher"), usage: { input: 1, output: 1 } } : { ...yieldAnswer("ok"), usage: { input: 2, output: 2 } };
		}, 1_000);
		agentFile(dirs, "researcher.md", "name: researcher\ndescription: Searches the web.\ntools: web_search");
		const { end } = await host({ dirs, opts: { prompt: "count", outputSchema: ANSWER_SCHEMA } });
		expect(end).toMatchObject({ t: "done", result: { usage: { input: 33, output: 23 } } });
	}, 60_000);
});
