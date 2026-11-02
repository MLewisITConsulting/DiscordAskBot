/**
 * OPS-06: one `ask` run on this machine, without Discord.
 *
 *   bun run dry-run --prompt <text> [--file <path>]… [--omp-dir <dir>] [--model <id>] [--thinking <level>] [--agent-dir <dir>]
 *
 * Does what a worker does for an ask run (architecture §2.3): makes the run directories in a temporary directory, copies
 * the given files into the scratch copy's `inputs/` (named as CHAT-09 names attachments), seeds a run-private auth store,
 * and spawns the agent host with the `ask` profile, the engine's prompt, output schema and limits. `--omp-dir` supplies
 * the skills and agents (AGT-24; `skills/<name>/SKILL.md`, `agents/<name>.md`). Sign-ins come from the developer's own
 * omp agent dir (`--agent-dir`, else `PI_CODING_AGENT_DIR`, else `~/.omp/agent`), which also refreshes them for the run
 * like the orchestrator does (CRED-03); provider API keys in the environment reach omp unchanged. Progress goes to
 * stderr; the answer (JSON), the files produced in `outputs/` and the usage go to stdout. The temporary directory is
 * always removed, also on Ctrl-C.
 */
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { postmortem } from "@oh-my-pi/pi-utils";
import { ASK_MINUTES, askPrompt, CHAT_SCHEMA } from "../src/orchestrator/engine/prompts";
import { listOmpAssets } from "../src/orchestrator/store/ompAssets";
import { safeFileName } from "../src/orchestrator/store/scratch";
import { openSigninStore, type Signins } from "../src/orchestrator/store/signins";
import { type Config, parseConfig } from "../src/shared/config";
import { errorMessage } from "../src/shared/log";
import { emptyOmpConfig } from "../src/shared/ompconfig";
import type { ChildMessage, HostResult, ParentMessage, Reply, StartOptions } from "../src/shared/protocol";
import { seedAuthStore } from "../src/worker/auth";
import { killMarkedProcesses } from "../src/worker/host/reap";
import { DEFAULT_TIMING, HOST_ENTRY, hostEnv, listOutputFiles, makeRunDirs } from "../src/worker/runner";

export interface DryRunOptions {
	prompt: string;
	/** Files copied into `inputs/`. */
	files?: readonly string[];
	/** Skills and agents root (AGT-24). */
	ompDir?: string;
	model?: string;
	thinking?: string;
	/** The omp agent dir whose sign-ins the run uses. */
	agentDir: string;
	/** Parent of the temporary run directory (default the OS temp dir). */
	tmpDir?: string;
	/** The agent host entry; tests use the fixture host. */
	hostEntry?: string;
	/** The answer, the produced files and the usage. */
	out: NodeJS.WritableStream;
	/** Progress and warnings. */
	err: NodeJS.WritableStream;
	/** Ctrl-C: the run is aborted (as by a user), then cleaned up. */
	signal?: AbortSignal;
}

/** A problem with the options or the environment, reported without a stack. */
export class DryRunError extends Error {
	override name = "DryRunError";
}

const USAGE =
	"usage: bun run dry-run --prompt <text> [--file <path>]… [--omp-dir <dir>] [--model <id>] [--thinking <level>] [--agent-dir <omp agent dir>]";

/** The developer's omp agent dir: `PI_CODING_AGENT_DIR`, else `~/.omp/agent`. */
export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
}

/** Opens the developer's sign-in store and checks that some model can be used with it or with the environment's keys. */
async function openCredentials(agentDir: string, model: string | undefined): Promise<Signins> {
	const signins = await openSigninStore(agentDir);
	try {
		const registry = new ModelRegistry(signins.authStorage, join(agentDir, "models.yml"));
		await registry.refresh("offline");
		const available = registry.getAvailable();
		if (available.length === 0) {
			throw new DryRunError(
				`no model credentials: ${join(agentDir, "agent.db")} has no usable sign-in and no provider API key is set in the environment. Sign in with \`omp\` (or pass --agent-dir), or set a key such as ANTHROPIC_API_KEY.`,
			);
		}
		if (model && !parseModelPattern(model, available).model) {
			const names = available.map(m => `${m.provider}/${m.id}`);
			throw new DryRunError(`--model ${model}: no available model matches; available: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ", …" : ""}`);
		}
		return signins;
	} catch (err) {
		signins.close();
		throw err;
	}
}

/** The `--file` paths, checked, with the collision-free CHAT-09 names they get in `inputs/`. */
async function inputFiles(paths: readonly string[]): Promise<{ path: string; name: string }[]> {
	const taken = new Set<string>();
	const files: { path: string; name: string }[] = [];
	for (const raw of paths) {
		const path = resolve(raw);
		if (!(await stat(path).catch(() => undefined))?.isFile()) throw new DryRunError(`--file ${path}: no such file`);
		const base = safeFileName(path);
		const dot = base.lastIndexOf(".");
		const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${ext}`;
		taken.add(name);
		files.push({ path, name });
	}
	return files;
}

function usageLine(result: HostResult): string {
	const { usage } = result;
	const parts = [
		`cost: $${usage.costUsd.toFixed(4)}`,
		`tokens in ${usage.input} / out ${usage.output} / cache read ${usage.cacheRead} / cache write ${usage.cacheWrite}`,
		...(result.oomKills > 0 ? [`OOM kills ${result.oomKills}`] : []),
		...(result.aborted ? [`aborted: ${result.aborted}`] : []),
	];
	return parts.join(" · ");
}

/** Runs one ask turn; prints the answer, the produced files and the usage to `out`. Throws `DryRunError` for bad options. */
export async function dryRun(opts: DryRunOptions): Promise<HostResult> {
	if (!opts.prompt.trim()) throw new DryRunError("--prompt is empty");
	let config: Config;
	try {
		// The engine's defaults for agent name, thinking and limits; --model and --thinking validated like the settings.
		config = parseConfig({
			discord: { guildId: "dry-run", allowedUserIds: ["dry-run"] },
			models: { ...(opts.model ? { ask: opts.model } : {}), ...(opts.thinking ? { thinking: opts.thinking } : {}) },
		});
	} catch (err) {
		throw new DryRunError(errorMessage(err).replace("Invalid config: models.thinking", "--thinking").replace("Invalid config: models.ask", "--model"));
	}
	const ompDir = opts.ompDir ? resolve(opts.ompDir) : undefined;
	if (ompDir && !(await stat(ompDir).catch(() => undefined))?.isDirectory()) throw new DryRunError(`--omp-dir ${ompDir}: no such directory`);
	const files = await inputFiles(opts.files ?? []);
	// The prompt names `task` only when the run will have it: at least one valid agent installed (AGT-13, AGT-25).
	const hasAgents = ompDir ? (await listOmpAssets(ompDir)).agents.some(agent => !agent.problem) : false;
	const signins = await openCredentials(opts.agentDir, config.models.ask);
	const runId = crypto.randomUUID();
	const marker = crypto.randomUUID();
	const root = await mkdtemp(join(opts.tmpDir ?? tmpdir(), "askbot-dry-run-"));
	let proc: Subprocess | undefined;
	let exited = false;
	let killTimer: Timer | undefined;
	const killGroup = () => {
		if (!proc || exited) return;
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	};
	const send = (msg: ParentMessage) => {
		if (!proc || exited) return;
		try {
			proc.send(msg);
		} catch (err) {
			opts.err.write(`warning: agent host send failed: ${errorMessage(err)}\n`);
		}
	};
	const onAbort = () => {
		opts.err.write("\ninterrupted: aborting the run…\n");
		send({ t: "abort", id: -1, reason: "user" });
		killTimer ??= setTimeout(killGroup, DEFAULT_TIMING.abortKillMs);
	};
	const reply = (id: number, result: { ok: true; value?: unknown } | { ok: false; error: string }) => send({ t: "reply", id, ...result } as Reply);
	try {
		const dirs = await makeRunDirs(root, root);
		// The worker's copy of the skills and agents: the host deletes invalid agents (AGT-31), never in the developer's dir.
		if (ompDir) await cp(ompDir, dirs.omp, { recursive: true, verbatimSymlinks: true });
		const credentialIds = await seedAuthStore(dirs.auth, await signins.snapshotForRun());
		// The developer's custom models and providers, which the credentials check above counted.
		const models = join(opts.agentDir, "models.yml");
		if (existsSync(models)) await copyFile(models, join(dirs.auth, "models.yml"));
		const inputs: string[] = [];
		for (const file of files) {
			await copyFile(file.path, join(dirs.scratch, "inputs", file.name));
			inputs.push(`inputs/${file.name}`);
		}
		opts.err.write(`dry run: asking${inputs.length > 0 ? ` with ${inputs.join(", ")}` : ""}${ompDir ? `, skills and agents from ${ompDir}` : ""}\n`);

		const startOpts: StartOptions = {
			runId,
			cwd: dirs.work,
			sessionDir: dirs.sessions,
			profile: "ask",
			...(config.models.ask ? { modelPattern: config.models.ask } : {}),
			thinking: config.models.thinking,
			prompt: askPrompt(config.agent.name, opts.prompt, inputs, hasAgents),
			outputSchema: CHAT_SCHEMA,
			limits: { minutes: ASK_MINUTES, costUsd: config.limits.maxCostUsdPerTurn },
			omp: emptyOmpConfig(),
			wantLoadout: true,
			scratchRoot: dirs.scratch,
		};
		const outcome = Promise.withResolvers<HostResult>();
		const startedAt = Date.now();
		let lastLine = "";
		const fromHost = (msg: ChildMessage) => {
			switch (msg.t) {
				case "progress": {
					// Also sent at each turn end with the last tool, to report cost: print each tool once.
					const line = msg.tool ? `${msg.tool}${msg.intent ? ` — ${msg.intent}` : ""}` : "";
					if (!line || line === lastLine) return;
					lastLine = line;
					opts.err.write(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${line}\n`);
					return;
				}
				case "session_file":
					reply(msg.id, { ok: true });
					return;
				case "credential_request": {
					const credentialId = credentialIds.get(msg.credentialId);
					if (credentialId === undefined) {
						reply(msg.id, { ok: false, error: `revoked: credential ${msg.credentialId} is not part of this run's sign-ins` });
						return;
					}
					void signins
						.handleCredentialRequest({ provider: msg.provider, credentialId, ...(msg.accessToken ? { accessToken: msg.accessToken } : {}) })
						.then(answer =>
							reply(msg.id, answer.ok ? { ok: true, value: { accessToken: answer.accessToken, expiresAt: answer.expiresAt } } : { ok: false, error: answer.error }),
						);
					return;
				}
				case "log": {
					// The host's own log lines, at warning level and up.
					let entry: { level?: string } = {};
					try {
						entry = JSON.parse(msg.line);
					} catch {}
					if (entry.level === "warn" || entry.level === "error") opts.err.write(`${entry.level}: ${msg.line}\n`);
					return;
				}
				case "transcript":
					// The tool calls with their arguments, as the thread's transcript records them (RUN-16).
					if (msg.event.type === "tool_start") opts.err.write(`  ${msg.event.tool} ${msg.event.args}\n`);
					return;
				case "loadout": {
					// AGT-27: what the session actually had.
					const { tools, skills, agents } = msg.loadout;
					opts.err.write(
						`loadout: tools ${tools.join(", ")} · skills ${skills.map(s => s.name).join(", ") || "(none)"} · agents ${agents.map(a => a.name).join(", ") || "(none)"}\n`,
					);
					return;
				}
				case "done":
					outcome.resolve(msg.result);
					return;
				case "failed":
					outcome.reject(new Error(`the agent run failed (${msg.name}): ${msg.message}`));
					return;
			}
		};
		proc = Bun.spawn({
			cmd: [process.execPath, opts.hostEntry ?? HOST_ENTRY],
			cwd: dirs.root,
			env: hostEnv(dirs, marker),
			stdin: "ignore",
			// Its log lines arrive as `log` messages too; stdout stays the answer's.
			stdout: "ignore",
			stderr: "inherit",
			serialization: "json",
			// Own process group: Ctrl-C reaches only this process, which aborts the run; a kill takes the tools with it.
			detached: true,
			ipc: message => fromHost(message as ChildMessage),
			onExit: (_proc, code, signal) => {
				exited = true;
				// A result sent just before the exit is already delivered or follows within the drain wait.
				setTimeout(() => outcome.reject(new Error(`the agent host exited without a result (${signal ? `signal ${signal}` : `code ${code}`})`)), DEFAULT_TIMING.disconnectWaitMs);
			},
		});
		send({ t: "start", runtime: { agentDir: dirs.auth, ompDir: dirs.omp, providerKeys: {} }, opts: startOpts });
		if (opts.signal?.aborted) onAbort();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });

		const result = await outcome.promise;
		opts.out.write(`${result.output === undefined ? "(no answer)" : JSON.stringify(result.output, null, 2)}\n`);
		// CHAT-10: new or changed regular files in `outputs/`, also after a stop; text formats only, so printed as text.
		const outputs = join(dirs.scratch, "outputs");
		for (const file of await listOutputFiles(outputs)) {
			const content = await readFile(file.path, "utf8");
			opts.out.write(`\n== outputs/${relative(outputs, file.path)} (${Buffer.byteLength(content)} bytes)\n${content}${content.endsWith("\n") ? "" : "\n"}`);
		}
		opts.out.write(`${usageLine(result)}\n`);
		return result;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		clearTimeout(killTimer);
		killGroup();
		killMarkedProcesses(marker);
		signins.close();
		await rm(root, { recursive: true, force: true });
	}
}

async function main(): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			options: {
				prompt: { type: "string" },
				file: { type: "string", multiple: true },
				"omp-dir": { type: "string" },
				model: { type: "string" },
				thinking: { type: "string" },
				"agent-dir": { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (err) {
		console.error(`dry-run: ${errorMessage(err)}\n${USAGE}`);
		return 2;
	}
	const { values } = parsed;
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (!values.prompt) {
		console.error(`dry-run: --prompt is required\n${USAGE}`);
		return 2;
	}
	const interrupt = new AbortController();
	const run = dryRun({
		prompt: values.prompt,
		files: values.file ?? [],
		ompDir: values["omp-dir"],
		model: values.model,
		thinking: values.thinking,
		agentDir: resolve(values["agent-dir"] ?? defaultAgentDir()),
		out: process.stdout,
		err: process.stderr,
		signal: interrupt.signal,
	});
	// omp's SDK owns SIGINT and SIGTERM (it runs registered cleanups, then exits): abort the run and clean up first.
	postmortem.register(
		"askbot-dry-run",
		async () => {
			interrupt.abort();
			await run.catch(() => {});
		},
		{ exitOnly: true },
	);
	try {
		const result = await run;
		return result.aborted ? 130 : 0;
	} catch (err) {
		console.error(`dry-run: ${errorMessage(err)}`);
		return err instanceof DryRunError ? 2 : 1;
	}
}

if (import.meta.main) process.exit(await main());
