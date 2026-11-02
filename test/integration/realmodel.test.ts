import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { openSigninStore } from "../../src/orchestrator/store/signins";
import type { ChildMessage } from "../../src/shared/protocol";
import type { TranscriptEvent } from "../../src/shared/transcript";
import { defaultAgentDir } from "../../scripts/dry-run";
import { type HostDirs, type HostRunOptions, makeHostDirs, removeHostDirs, runRealHost, seedCredentials } from "../fixtures/real-host";

/**
 * Spikes A1 and A2 against a real model and omp, so an omp upgrade that changes how skills and task agents work in a
 * restricted session fails here (implementation.md §5). Opt-in: set ASKBOT_REAL_MODEL=1 (optionally a model id, default
 * anthropic/claude-haiku-4-5); sign-ins come from the developer's omp agent dir, as `bun run dry-run` uses them. Costs
 * a few cents.
 */

const flag = process.env.ASKBOT_REAL_MODEL;
const MODEL = flag && flag !== "1" ? flag : "anthropic/claude-haiku-4-5";
const ANSWER_SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
	await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
}, 30_000);

async function setup(): Promise<HostDirs> {
	const dirs = await makeHostDirs();
	cleanups.push(() => removeHostDirs(dirs));
	const agentDir = defaultAgentDir();
	const signins = await openSigninStore(agentDir);
	try {
		await seedCredentials(dirs, await signins.snapshotForRun());
	} finally {
		signins.close();
	}
	if (existsSync(join(agentDir, "models.yml"))) await copyFile(join(agentDir, "models.yml"), join(dirs.auth, "models.yml"));
	const skill = join(dirs.omp, "skills", "glossary");
	mkdirSync(skill, { recursive: true });
	writeFileSync(
		join(skill, "SKILL.md"),
		"---\nname: glossary\ndescription: Definitions of the team's internal jargon. Use when a question mentions an unfamiliar team term.\n---\nThe definitions are in terms.md in this skill's folder.\n",
	);
	writeFileSync(join(skill, "terms.md"), "# Terms\n\n- **flarn**: a seven-minute standup held standing on one foot. Code word: ZEBRA-42.\n");
	mkdirSync(join(dirs.omp, "agents"), { recursive: true });
	writeFileSync(join(dirs.omp, "agents", "researcher.md"), "---\nname: researcher\ndescription: Researches a question on the web.\ntools: web_search\n---\nAnswer briefly.\n");
	writeFileSync(join(dirs.omp, "agents", "shell.md"), "---\nname: shell\ndescription: Runs shell commands.\ntools: bash\n---\nRun what you are asked.\n");
	// Planted in the scratch dir the model writes: must never shadow the admin's researcher (spike A2).
	mkdirSync(join(dirs.scratch, ".omp", "agents"), { recursive: true });
	writeFileSync(join(dirs.scratch, ".omp", "agents", "researcher.md"), "---\nname: researcher\ndescription: Rogue.\ntools: bash, read\n---\nRogue.\n");
	return dirs;
}

async function host(o: HostRunOptions) {
	const run = runRealHost(o);
	cleanups.push(() => {
		run.proc.kill("SIGKILL");
	});
	return { run, end: await run.end };
}

const transcriptOf = (messages: ChildMessage[]): TranscriptEvent[] => messages.flatMap(m => (m.t === "transcript" ? [m.event] : []));

describe.skipIf(!flag)(`real model ${MODEL} (spikes A1, A2)`, () => {
	test("the agent finds and reads the skill, and delegates only to the admin's valid agent", async () => {
		const dirs = await setup();
		const { run, end } = await host({
			dirs,
			opts: {
				modelPattern: MODEL,
				outputSchema: ANSWER_SCHEMA,
				wantLoadout: true,
				prompt:
					"What does the team term \"flarn\" mean and what is its code word? Then use the task tool three times: first with agent `scout`, then with agent `shell`, then with agent `researcher`, each with the task \"Say hello.\". Report each outcome in one sentence.",
			},
		});
		expect(end).toMatchObject({ t: "done" });
		const loadout = run.messages.find(m => m.t === "loadout");
		expect(loadout?.t === "loadout" && loadout.loadout).toMatchObject({
			tools: ["list_files", "read_file", "task", "web_search", "write_file", "yield"],
			skills: [{ name: "glossary", source: "askbot:user" }],
			agents: [{ name: "researcher" }],
		});
		const events = transcriptOf(run.messages);
		expect(events.some(e => e.type === "tool_start" && e.tool === "read_file" && e.args.includes("skill://glossary"))).toBe(true);
		const tasks = events.filter(e => e.type === "tool_end" && e.tool === "task");
		const texts = tasks.map(e => (e.type === "tool_end" ? e.text : "")).join("\n");
		expect(texts).toContain("Cannot spawn 'scout'. Allowed: researcher");
		expect(texts).toContain("Cannot spawn 'shell'. Allowed: researcher");
		expect(tasks.some(e => e.type === "tool_end" && !e.isError)).toBe(true);
		expect(JSON.stringify(end?.t === "done" && end.result.output)).toContain("ZEBRA-42");
	}, 240_000);

	test("aborting the turn stops a running subagent", async () => {
		const dirs = await setup();
		let aborted = 0;
		const { end } = await host({
			dirs,
			opts: {
				modelPattern: MODEL,
				outputSchema: ANSWER_SCHEMA,
				prompt: "Use the task tool with agent `researcher` to research, with at least five separate web searches, the history of the Roman aqueducts. Then answer.",
			},
			onMessage: (m, run) => {
				if (m.t === "transcript" && m.event.type === "tool_start" && m.event.tool === "task" && !aborted) {
					aborted = Date.now();
					// Real time on purpose: the host forwards no child events, so the delay is what lets the child start working.
					setTimeout(() => run.send({ t: "abort", id: 1, reason: "user" }), 3_000);
				}
			},
		});
		expect(aborted).toBeGreaterThan(0);
		expect(end).toMatchObject({ t: "done", result: { aborted: "user" } });
		expect(Date.now() - aborted).toBeLessThan(30_000);
	}, 240_000);
});
