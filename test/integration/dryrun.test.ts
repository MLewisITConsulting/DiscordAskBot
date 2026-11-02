import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DryRunError, dryRun, type DryRunOptions } from "../../scripts/dry-run";
import { ASK_MINUTES, CHAT_SCHEMA } from "../../src/orchestrator/engine/prompts";
import { seedAuthStore } from "../../src/worker/auth";

const FIXTURE_HOST = join(import.meta.dir, "..", "fixtures", "agent-host.ts");
const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "dry-run.ts");

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** An omp agent dir with one API-key sign-in, so a model is available without the environment. */
async function makeAgentDir(): Promise<string> {
	const dir = tempDir("dryrun-agent-");
	await seedAuthStore(dir, [{ id: 1, provider: "anthropic", credential: { type: "api_key", key: "sk-ant-test" } }]);
	return dir;
}

/** What the fixture host's `dryRun` script yields: an answer plus what it saw. */
interface FixtureAnswer {
	answer: string;
	seen: { inputs: string[]; cwdIsScratch: boolean; ompDir: string; profile: string; thinking: string; model: string | null; limits: unknown; schema: unknown };
}

function text(stream: PassThrough): () => string {
	let collected = "";
	stream.on("data", chunk => {
		collected += String(chunk);
	});
	return () => collected;
}

async function setup(prompt: string) {
	const runParent = tempDir("dryrun-tmp-");
	const out = new PassThrough();
	const err = new PassThrough();
	const opts: DryRunOptions = { prompt, agentDir: await makeAgentDir(), tmpDir: runParent, hostEntry: FIXTURE_HOST, out, err };
	return { opts, out: text(out), err: text(err), errStream: err, runParent };
}

describe("dry run (OPS-06)", () => {
	test("runs the ask profile on a scratch copy with the files in inputs/, prints the answer, outputs and usage, cleans up", async () => {
		const { opts, out, err, runParent } = await setup("Summarise these. fixture:dryRun");
		const files = tempDir("dryrun-files-");
		mkdirSync(join(files, "b"));
		writeFileSync(join(files, "notes.txt"), "one\n");
		writeFileSync(join(files, "b", "notes.txt"), "two\n");
		writeFileSync(join(files, "my report?.csv"), "a,b\n");
		const ompDir = tempDir("dryrun-omp-");
		const result = await dryRun({
			...opts,
			files: [join(files, "notes.txt"), join(files, "b", "notes.txt"), join(files, "my report?.csv")],
			ompDir,
			model: "claude-haiku",
			thinking: "low",
		});
		const output = result.output as FixtureAnswer;
		// CHAT-09 names, collision-free; the engine's schema and limits.
		expect(output.seen).toEqual({
			inputs: ["my report_.csv", "notes-2.txt", "notes.txt"],
			// AGT-24: the session's cwd is the run's work dir, never the scratch dir; the skills and agents are the run's copy.
			cwdIsScratch: false,
			ompDir: expect.stringMatching(/askbot-dry-run-[^/]+\/omp$/),
			profile: "ask",
			thinking: "low",
			model: "claude-haiku",
			limits: { minutes: ASK_MINUTES, costUsd: 15 },
			schema: CHAT_SCHEMA,
		});
		const printed = out();
		expect(JSON.parse(printed.slice(0, printed.indexOf("\n}\n") + 2))).toEqual(output);
		expect(printed).toContain("== outputs/notes.md (");
		expect(printed).toContain("# Notes\n- my report_.csv\n- notes-2.txt\n- notes.txt\n");
		expect(printed).toEndWith("cost: $0.2500 · tokens in 1200 / out 340 / cache read 50 / cache write 7\n");
		expect(err()).toContain("dry run: asking with inputs/notes.txt, inputs/notes-2.txt, inputs/my report_.csv");
		expect(err()).toContain("read_file — Reading the inputs");
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("a failed run is reported and the scratch copy removed", async () => {
		const { opts, out, runParent } = await setup("fixture:failure");
		await expect(dryRun(opts)).rejects.toThrow("the agent run failed (Error): model exploded");
		expect(out()).toBe("");
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("an interrupt aborts the run as the user's and cleans up", async () => {
		const { opts, out, errStream, runParent } = await setup("fixture:steerable");
		const asking = Promise.withResolvers<void>();
		errStream.on("data", chunk => String(chunk).includes("dry run: asking") && asking.resolve());
		const interrupt = new AbortController();
		const running = dryRun({ ...opts, signal: interrupt.signal });
		await asking.promise;
		expect(readdirSync(runParent)).toHaveLength(1);
		interrupt.abort();
		const result = await running;
		expect(result.aborted).toBe("user");
		expect(out()).toContain("aborted: user");
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("clear errors for an empty prompt, a missing file or omp dir, an unknown model or a bad thinking level", async () => {
		const { opts, runParent } = await setup("fixture:dryRun");
		const missing = join(tempDir("dryrun-plain-"), "missing");
		await expect(dryRun({ ...opts, prompt: "  " })).rejects.toThrow("--prompt is empty");
		await expect(dryRun({ ...opts, files: [missing] })).rejects.toThrow(`--file ${missing}: no such file`);
		await expect(dryRun({ ...opts, ompDir: missing })).rejects.toThrow(`--omp-dir ${missing}: no such directory`);
		await expect(dryRun({ ...opts, model: "no-such-model-xyz" })).rejects.toThrow("--model no-such-model-xyz: no available model matches");
		await expect(dryRun({ ...opts, thinking: "loud" })).rejects.toBeInstanceOf(DryRunError);
		expect(readdirSync(runParent)).toEqual([]);
	});

	test("the CLI reports missing credentials clearly", async () => {
		const home = tempDir("dryrun-home-");
		const proc = Bun.spawn([process.execPath, SCRIPT, "--prompt", "2+2?", "--agent-dir", join(home, "agent")], {
			// No provider keys from the developer's environment.
			env: { PATH: process.env.PATH, HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(2);
		expect(stderr).toContain("dry-run: no model credentials:");
	});

	test("the CLI requires --prompt", async () => {
		const proc = Bun.spawn([process.execPath, SCRIPT], { stdout: "pipe", stderr: "pipe" });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(code).toBe(2);
		expect(stderr).toContain("--prompt is required");
	});
});
