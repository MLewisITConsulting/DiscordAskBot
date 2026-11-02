// Agent host for tests: the real protocol server (`serveAgentHost`) running a scripted fake session instead of omp.
// The script is chosen by `start.opts.prompt` (exact name), or by a `fixture:<name>` marker inside a longer prompt (the
// `/ask` prompts the engine builds around the user's text). No omp code is loaded, so it starts fast.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, log } from "../../src/shared/log";
import type { HostResult, HostRuntime } from "../../src/shared/protocol";
import type { RunUsage } from "../../src/shared/transcript";
import { readOomKills } from "../../src/worker/host/oom";
import { type CredentialRequester, NoStructuredOutput, serveAgentHost, type SessionOptions } from "../../src/worker/host/serve";
import type { SessionRuntime } from "../../src/worker/host/session";

/** What `openRuntime` hands the fixture: the start message's runtime plus the credential requester. */
type FixtureRuntime = HostRuntime & { requestCredential: CredentialRequester };

const usage = (costUsd: number): RunUsage => ({ costUsd, input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

/** Writes `<sessionDir>/fixture.jsonl` (so a supervisor can upload it) with an optional script record; returns its path. */
function sessionFile(opts: SessionOptions, record?: FixtureRecord): string {
	mkdirSync(opts.sessionDir, { recursive: true });
	const path = join(opts.sessionDir, "fixture.jsonl");
	writeFileSync(path, [{ type: "session", runId: opts.runId }, ...(record ? [record] : [])].map(r => `${JSON.stringify(r)}\n`).join(""));
	return path;
}

/** A session's record of the script that wrote it, so a resumed run (whose prompt has no marker) plays it again. */
interface FixtureRecord {
	type: "fixture";
	script: string;
	holdSeconds: number;
}

function recordedScript(resumeFile: string): Partial<FixtureRecord> | undefined {
	try {
		for (const line of readFileSync(resumeFile, "utf8").split("\n")) {
			const record: Partial<FixtureRecord> = line ? JSON.parse(line) : {};
			if (record.type === "fixture" && typeof record.script === "string") return record;
		}
	} catch {}
	return undefined;
}

function result(opts: SessionOptions, extra: Partial<HostResult> = {}, record?: FixtureRecord): HostResult {
	return { sessionFile: sessionFile(opts, record), usage: usage(0.5), oomKills: 0, ...extra };
}

/** `fixture-<name>-seconds:<n>` from the prompt, else `fallback`. */
function promptSeconds(prompt: string, name: string, fallback: number): number {
	const match = new RegExp(`\\bfixture-${name}-seconds:(\\d+)`).exec(prompt);
	return match ? Number(match[1]) : fallback;
}

/** Starts `sleep 300` once in the agent's process group and once in its own session; reports both pids as a `spawn` tool event. */
function reportLeftovers(opts: SessionOptions): void {
	const pids = [false, true].map(detached => {
		const child = spawn("sleep", ["300"], { stdio: "ignore", detached });
		child.unref();
		return child.pid;
	});
	opts.onTranscript({ type: "tool_start", tool: "spawn", intent: "", args: JSON.stringify(pids) });
}

/**
 * `TEST_HOST_DUMP_DIR` (SEC-01, AGT-02): writes `<dir>/<runId>.json` with everything the run's agent can read from its
 * host: the environment, the start message (runtime and options) and every file in its agent dir (the auth store).
 */
function dumpRun(dir: string, opts: SessionOptions, runtime: FixtureRuntime): void {
	const files: Record<string, string> = {};
	for (const name of readdirSync(runtime.agentDir, { recursive: true, encoding: "utf8" })) {
		const path = join(runtime.agentDir, name);
		if (statSync(path).isFile()) files[name] = readFileSync(path, "latin1");
	}
	const { requestCredential: _rc, ...hostRuntime } = runtime;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${opts.runId}.json`), JSON.stringify({ env: process.env, runtime: hostRuntime, opts, files }));
}


const scripts: Record<string, (opts: SessionOptions, runtime: FixtureRuntime) => Promise<HostResult>> = {
	async happy(opts, runtime) {
		const file = sessionFile(opts);
		await opts.onSessionFile(file);
		opts.onTranscript({ type: "prompt", text: "the prompt" });
		opts.onLoadout?.({ capturedAt: new Date(0).toISOString(), profile: opts.profile, tools: ["read_file"], skills: [], agents: [] });
		opts.register({ steer: async () => {}, abort: async () => {} });
		opts.onProgress({ tool: "read_file", intent: "reading", usage: usage(0.1), elapsedMs: 5 });
		opts.onTranscript({ type: "tool_start", tool: "read_file", intent: "reading", args: "{}" });
		opts.onProgress({ usage: usage(0.4), elapsedMs: 9 });
		mkdirSync(join(opts.scratchRoot, "outputs"), { recursive: true });
		writeFileSync(join(opts.scratchRoot, "outputs", "answer.md"), "fixture answer\n");
		opts.onUsage(usage(0.5));
		opts.onTranscript({ type: "run_end", usage: usage(0.5) });
		const { onProgress: _p, onTranscript: _t, onUsage: _u, onLoadout: _l, onSessionFile: _s, register: _r, ...data } = opts;
		const { requestCredential: _rc, ...hostRuntime } = runtime;
		return { sessionFile: file, usage: usage(0.5), oomKills: 2, output: { runtime: hostRuntime, data, hasLoadoutCallback: !!opts.onLoadout } };
	},
	async bigTranscript(opts) {
		opts.onTranscript({ type: "tool_end", tool: "read_file", isError: false, text: "x".repeat(100_000) });
		return result(opts);
	},
	async credential(opts, runtime) {
		const output = await runtime.requestCredential({ provider: "fixture", credentialId: "1", accessToken: "old" }).then(
			value => ({ value }),
			err => ({ error: errorMessage(err) }),
		);
		return result(opts, { output });
	},
	async steerable(opts) {
		await opts.onSessionFile(sessionFile(opts));
		const steered: string[] = [];
		const { promise, resolve } = Promise.withResolvers<HostResult["aborted"]>();
		opts.register({
			steer: async text => {
				steered.push(text);
			},
			abort: async reason => resolve(reason),
		});
		const aborted = await promise;
		return result(opts, { output: steered, aborted });
	},
	/** Registers only after 300 ms, so an abort can arrive first. */
	async lateRegister(opts) {
		await Bun.sleep(300);
		const { promise, resolve } = Promise.withResolvers<HostResult["aborted"]>();
		opts.register({ steer: async () => {}, abort: async reason => resolve(reason) });
		return result(opts, { aborted: await promise });
	},
	async exit(opts) {
		opts.onProgress({ usage: usage(0.3), elapsedMs: 1 });
		await Bun.sleep(50);
		process.exit(3);
	},
	async leavesChildren(opts) {
		reportLeftovers(opts);
		return result(opts);
	},
	async leavesChildrenThenExit(opts) {
		reportLeftovers(opts);
		await Bun.sleep(100);
		process.exit(3);
	},
	async selfKill(opts) {
		opts.onProgress({ usage: usage(0.3), elapsedMs: 1 });
		await Bun.sleep(50);
		process.kill(process.pid, "SIGKILL");
		return await new Promise<HostResult>(() => {});
	},
	/**
	 * `fixture:oomSelfKill`: the kernel OOM-kills the agent host. Raises the `oom_kill` counter in the file the worker
	 * reads instead of the cgroup's (`$TEST_MEMORY_EVENTS`, see `fake-cgroup.ts`), then SIGKILLs itself (AGT-05).
	 */
	async oomSelfKill(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const events = process.env.TEST_MEMORY_EVENTS;
		if (!events) throw new Error("oomSelfKill needs TEST_MEMORY_EVENTS");
		writeFileSync(events, `oom 1\noom_kill ${(readOomKills(events) ?? 0) + 1}\n`);
		process.kill(process.pid, "SIGKILL");
		return await new Promise<HostResult>(() => {});
	},
	async hung(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.onProgress({ usage: usage(0.2), elapsedMs: 1 });
		opts.register({ steer: async () => {}, abort: () => new Promise<void>(() => {}) });
		return await new Promise<HostResult>(() => {});
	},
	async noYield(opts) {
		log("info", "fixture log line", { run: opts.runId });
		throw new NoStructuredOutput();
	},
	async failure() {
		throw new Error("model exploded");
	},
	async sessionFileRejected(opts) {
		await opts.onSessionFile(sessionFile(opts));
		return result(opts, { output: "prompted anyway" });
	},
	/** An `/ask` turn: reads the first input, reports progress, writes `outputs/summary.txt`, answers. */
	async chatFile(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const scratch = opts.scratchRoot;
		const input = readdirSync(join(scratch, "inputs"))[0]!;
		opts.onProgress({ tool: "read_file", intent: `Reading ${input}`, usage: usage(0.1), elapsedMs: 5 });
		const firstLine = readFileSync(join(scratch, "inputs", input), "utf8").split("\n")[0]!;
		await Bun.sleep(100);
		mkdirSync(join(scratch, "outputs"), { recursive: true });
		writeFileSync(join(scratch, "outputs", "summary.txt"), `${input}: ${firstLine}\n`);
		opts.onProgress({ tool: "write_file", intent: "Writing the summary", usage: usage(0.3), elapsedMs: 9 });
		opts.onUsage(usage(0.5));
		return result(opts, { output: { answer: `Summarised \`${input}\` into \`outputs/summary.txt\`.` } });
	},
	/**
	 * An `/ask` turn that holds until it is steered with a message containing `finish`; then writes `outputs/held.txt`
	 * and answers, naming the files in `inputs/` (those a steer attached included).
	 */
	async chatHeld(opts) {
		await opts.onSessionFile(sessionFile(opts));
		const { promise, resolve } = Promise.withResolvers<HostResult["aborted"] | "finish">();
		opts.register({
			steer: async text => {
				if (text.includes("finish")) resolve("finish");
			},
			abort: async reason => resolve(reason),
		});
		opts.onProgress({ tool: "read_file", intent: "Holding", usage: usage(0.1), elapsedMs: 5 });
		const outcome = await promise;
		if (outcome !== "finish") return result(opts, { aborted: outcome });
		mkdirSync(join(opts.scratchRoot, "outputs"), { recursive: true });
		writeFileSync(join(opts.scratchRoot, "outputs", "held.txt"), "held\n");
		opts.onUsage(usage(0.5));
		const inputs = readdirSync(join(opts.scratchRoot, "inputs")).sort();
		return result(opts, { output: { answer: `Held run finished. Inputs: ${inputs.join(", ") || "none"}.` } });
	},
	/** Fills the scratch copy past a small disk limit, then waits to be stopped (STO-06). */
	async fillDisk(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		writeFileSync(join(opts.scratchRoot, "outputs", "big.txt"), Buffer.alloc(4 * 1024 * 1024, 97));
		return await new Promise<HostResult>(() => {});
	},
	/** Answers at once; resumed runs without a marker land here too. */
	async auto(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		opts.onUsage(usage(0.2));
		return result(opts, { output: { answer: "Fixture answer." } });
	},
	/**
	 * `fixture:slow`: answers like `auto`, but first holds for `fixture-hold-seconds:<n>` (default 40) with a progress
	 * line, repeated every `fixture-progress-seconds:<n>` when the prompt has it, so that many runs overlap and a worker
	 * can be stopped mid-run (test/e2e). The session records the script, so a resumed run (whose prompt has no marker)
	 * comes back here and answers at once.
	 */
	async slow(opts) {
		const resumed = opts.resumeFile ? recordedScript(opts.resumeFile) : undefined;
		const record: FixtureRecord = { type: "fixture", script: "slow", holdSeconds: resumed?.holdSeconds ?? promptSeconds(opts.prompt, "hold", 40) };
		await opts.onSessionFile(sessionFile(opts, record));
		const stopped = Promise.withResolvers<HostResult["aborted"]>();
		opts.register({ steer: async () => {}, abort: async reason => stopped.resolve(reason) });
		if (resumed) {
			log("info", "fixture resumed from the uploaded session", { run: opts.runId });
			return result(opts, { output: { answer: `Resumed in run ${opts.runId}.` } }, record);
		}
		const progressSeconds = promptSeconds(opts.prompt, "progress", 0);
		let calls = 0;
		const report = () => opts.onProgress({ tool: "web_search", intent: calls ? `searching slowly (${calls})` : "searching slowly", usage: usage(0.1 * ++calls), elapsedMs: 1 });
		report();
		const ticker = progressSeconds > 0 ? setInterval(report, progressSeconds * 1000) : undefined;
		log("info", "fixture holding", { run: opts.runId, seconds: record.holdSeconds });
		const aborted = await Promise.race([Bun.sleep(record.holdSeconds * 1000).then(() => undefined), stopped.promise]).finally(() => clearInterval(ticker));
		if (aborted) return result(opts, { aborted }, record);
		return result(opts, { output: { answer: "Fixture slow answer." } }, record);
	},
	/**
	 * `fixture:oomHost` (test/e2e): the agent host itself allocates memory until the kernel OOM-kills it, so the worker
	 * reports the run as most likely out of memory (AGT-05, AGT-17).
	 */
	async oomHost(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		opts.onProgress({ tool: "read_file", intent: "allocating until OOM-killed", usage: usage(0.1), elapsedMs: 1 });
		const hog: Buffer[] = [];
		for (;;) {
			hog.push(Buffer.alloc(32 * 1024 * 1024, 1));
			await Bun.sleep(20);
		}
	},
	/**
	 * `fixture:oomChild` (test/e2e): a subprocess of the host allocates memory until the kernel OOM-kills it; the run
	 * carries on and reports the cgroup's `oom_kill` count (AGT-17, AGT-19), so the answer carries the warning.
	 */
	async oomChild(opts) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		const before = readOomKills();
		const child = Bun.spawn([process.execPath, "-e", "const a = []; for (;;) { a.push(Buffer.alloc(32 * 1024 * 1024, 1)); await Bun.sleep(20); }"], { stdio: ["ignore", "inherit", "inherit"] });
		await child.exited;
		const oomKills = Math.max(0, (readOomKills() ?? 0) - (before ?? 0));
		log("info", "fixture subprocess ended", { run: opts.runId, signal: child.signalCode, oomKills });
		opts.onProgress({ tool: "read_file", intent: "memory hog ended", usage: usage(0.1), elapsedMs: 1 });
		return result(opts, { oomKills, output: { answer: "Fixture answer after an OOM kill." } });
	},
	/** `scripts/dry-run.ts`: reports what it was started with and the inputs it sees, writes `outputs/notes.md`, answers. */
	async dryRun(opts, runtime) {
		await opts.onSessionFile(sessionFile(opts));
		opts.register({ steer: async () => {}, abort: async () => {} });
		opts.onProgress({ tool: "read_file", intent: "Reading the inputs", usage: usage(0.1), elapsedMs: 5 });
		const inputs = readdirSync(join(opts.scratchRoot, "inputs")).sort();
		writeFileSync(join(opts.scratchRoot, "outputs", "notes.md"), `# Notes\n${inputs.map(name => `- ${name}`).join("\n")}\n`);
		opts.onUsage(usage(0.25));
		return result(opts, {
			usage: { costUsd: 0.25, input: 1200, output: 340, cacheRead: 50, cacheWrite: 7 },
			output: {
				answer: `Saw ${inputs.length} input(s).`,
				seen: {
					inputs,
					cwdIsScratch: opts.cwd === opts.scratchRoot,
					ompDir: runtime.ompDir,
					profile: opts.profile,
					thinking: opts.thinking,
					model: opts.modelPattern ?? null,
					limits: opts.limits,
					schema: opts.outputSchema,
				},
			},
		});
	},
};

serveAgentHost({
	openRuntime: async (runtime, requestCredential) => ({ ...runtime, requestCredential }) as unknown as SessionRuntime,
	run: (runtime, opts) => {
		const script =
			scripts[opts.prompt] ??
			scripts[/\bfixture:(\w+)/.exec(opts.prompt)?.[1] ?? ""] ??
			(opts.resumeFile ? (scripts[recordedScript(opts.resumeFile)?.script ?? ""] ?? scripts.auto) : undefined);
		if (!script) throw new Error(`no script ${opts.prompt}`);
		const dumpDir = process.env.TEST_HOST_DUMP_DIR;
		if (dumpDir) dumpRun(dumpDir, opts, runtime as unknown as FixtureRuntime);
		return script(opts, runtime as unknown as FixtureRuntime);
	},
});
