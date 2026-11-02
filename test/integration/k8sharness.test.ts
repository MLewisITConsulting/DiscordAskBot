import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { workerRoot } from "../../src/worker/status";

/**
 * The e2e scenario orchestrator (test/e2e/k8s/orchestrator.ts) as plain processes: started with the env and token files
 * the chart gives it, with a stand-in for KEDA that starts one worker process (test/fixtures/worker-process.ts) per
 * pending run. Checks what the kind, compose and chaos drivers rely on: health limits and warnings follow the control
 * API's limits, `/ask` runs answer on workers of their own with `answer.md` in the thread, `/stop` stops a held run, and
 * a worker stopped with SIGTERM mid-run fails the turn as lost, after which the user's follow-up answers on a new worker.
 */

const ORCHESTRATOR = join(import.meta.dir, "..", "e2e", "k8s", "orchestrator.ts");
const WORKER_PROCESS = join(import.meta.dir, "..", "fixtures", "worker-process.ts");
const WEB_TOKEN = "k8s-harness-web-token";
const WORKER_TOKEN = "k8s-harness-worker-token";
const SCALE_TOKEN = "k8s-harness-scale-token";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(get: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs: number): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await get();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

interface Run {
	id: string;
	thread: string;
	state: string;
	outcome: string | null;
	worker: string | null;
	continues: string | null;
}
interface State {
	phase: string;
	pendingRuns: number;
	runs: Run[];
}
interface Thread {
	id: string;
	messages: { bot: boolean; content: string; files: string[]; answer: string | null }[];
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = probe.port!;
	await probe.stop(true);
	return port;
}

async function boot() {
	const root = await mkdtemp(join(tmpdir(), "askbot-k8sharness-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const files: Record<string, string> = { master: crypto.randomUUID() + crypto.randomUUID(), web: WEB_TOKEN, worker: WORKER_TOKEN, scale: SCALE_TOKEN };
	for (const [name, value] of Object.entries(files)) await writeFile(join(root, name), value);
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	let output = "";
	const orchestrator = Bun.spawn(["bun", ORCHESTRATOR], {
		env: {
			...process.env,
			ASKBOT_STATE_DIR: join(root, "state"),
			ASKBOT_OMP_DIR: join(root, "omp"),
			ASKBOT_INTERNAL_HOST: "127.0.0.1",
			ASKBOT_INTERNAL_PORT: String(port),
			ASKBOT_MASTER_KEY_FILE: join(root, "master"),
			ASKBOT_WEB_API_TOKEN_FILE: join(root, "web"),
			ASKBOT_WORKER_TOKEN_FILE: join(root, "worker"),
			ASKBOT_SCALE_TOKEN_FILE: join(root, "scale"),
			ASKBOT_WORKER_CAPACITY: "10",
			// Every worker process connects from 127.0.0.1 here; in kind each pod has its own address.
			ASKBOT_WORKER_ADDRESS_BINDING: "off",
			E2E_ADMIN_PASSWORD: "k8s-harness-password",
			// Short dispatcher timings: a SIGTERM'd worker counts as lost after 1.5 s, not the product's 45 s.
			E2E_LEASE_MS: "1500",
			E2E_SWEEP_MS: "50",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	for (const stream of [orchestrator.stdout, orchestrator.stderr]) {
		void (async () => {
			for await (const chunk of stream) output += new TextDecoder().decode(chunk);
		})();
	}
	cleanups.push(async () => {
		orchestrator.kill("SIGKILL");
		await orchestrator.exited;
		// HARNESS_LOG=<file> keeps the orchestrator's log for a failing run.
		if (process.env.HARNESS_LOG) await Bun.write(process.env.HARNESS_LOG, output);
	});

	const control = async (path: string, body?: object) => {
		const res = await fetch(`${url}/internal/admin/e2e/${path}`, {
			method: body ? "POST" : "GET",
			headers: { authorization: `Bearer ${WEB_TOKEN}`, "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
		return res.json();
	};
	const state = () => control("state") as Promise<State>;
	const thread = async (id: string) => ((await control("threads")) as Thread[]).find(t => t.id === id)!;
	const ask = async (prompt: string) => {
		const { thread: id, reply } = (await control("ask", { prompt })) as { thread: string | null; reply: string | null };
		if (!id) throw new Error(`/ask refused: ${reply}`);
		return id;
	};
	const botSaid = async (id: string, text: string) => (await thread(id)).messages.some(m => m.bot && m.content.includes(text));
	const health = async () => (await fetch(`${url}/readyz`)).json() as Promise<{ limits: Record<string, number> | null; warnings: string[] }>;

	// The stand-in for KEDA: `pendingRuns` from the scale endpoint, minus workers started but not yet claimed.
	const workers: { proc: Subprocess<"ignore", "pipe", "pipe">; id: string; startedAt: number; output: string }[] = [];
	const scaler = setInterval(async () => {
		const res = await fetch(`${url}/internal/scale`, { headers: { authorization: `Bearer ${SCALE_TOKEN}` } }).catch(() => undefined);
		if (!res?.ok) return;
		const { pendingRuns } = (await res.json()) as { pendingRuns: number };
		const starting = workers.filter(w => w.proc.exitCode === null && Date.now() - w.startedAt < 3_000).length;
		for (let i = starting; i < pendingRuns; i++) {
			const id = `harness-worker-${workers.length}`;
			const proc = Bun.spawn(["bun", WORKER_PROCESS], {
				env: { ...process.env, ASKBOT_ORCHESTRATOR_URL: url, TEST_WORKER_TOKEN: WORKER_TOKEN, TEST_WORKER_ID: id, TEST_CLAIM_TIMEOUT_MS: "4000" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const worker = { proc, id, startedAt: Date.now(), output: "" };
			for (const stream of [proc.stdout, proc.stderr]) {
				void (async () => {
					for await (const chunk of stream) worker.output += new TextDecoder().decode(chunk);
				})();
			}
			workers.push(worker);
		}
	}, 100);
	cleanups.push(async () => {
		clearInterval(scaler);
		for (const w of workers) {
			w.proc.kill("SIGKILL");
			await w.proc.exited;
			await rm(workerRoot(join(tmpdir(), "askbot-worker"), w.proc.pid), { recursive: true, force: true });
		}
	});

	await until(async () => (await fetch(`${url}/readyz`).catch(() => undefined))?.ok, "the orchestrator", 30_000).catch(err => {
		throw new Error(`${(err as Error).message}\n${output}`);
	});
	await until(async () => (await state()).phase === "running", "the engine", 30_000);
	return { control, state, thread, ask, botSaid, health, workers, output: () => output };
}

describe("e2e scenario orchestrator", () => {
	test("limits in health, /ask answers on workers of their own, /stop, and a SIGTERM'd worker's turn resumed by the next message", async () => {
		const h = await boot();

		// Seeded at the product default: below the capacity of 10, with the warning (RUN-11, RUN-12).
		expect(await h.health()).toMatchObject({ limits: { maxChatSessions: 2, workerCapacity: 10, effectiveConcurrency: 2 } });
		expect((await h.health()).warnings.join("\n")).toContain("below worker capacity (10)");
		await h.control("limits", { maxChatSessions: 10 });
		expect(await h.health()).toMatchObject({ limits: { maxChatSessions: 10, effectiveConcurrency: 10 }, warnings: [] });

		// Three questions at once: each answered with answer.md, each run on its own worker (architecture §4.4).
		const asked = await Promise.all([1, 2, 3].map(n => h.ask(`Question ${n} fixture:auto`)));
		for (const id of asked) await until(() => h.botSaid(id, "✅ **Done.**"), `the answer in ${id}`, 20_000);
		for (const id of asked) {
			const answers = (await h.thread(id)).messages.filter(m => m.bot && m.files.includes("answer.md"));
			expect(answers.map(m => m.content)).toEqual(["📄 **Answer attached:** `answer.md`"]);
		}
		const answered = (await h.state()).runs.filter(r => asked.includes(r.thread));
		expect(answered.map(r => r.outcome)).toEqual(["succeeded", "succeeded", "succeeded"]);
		expect(new Set(answered.map(r => r.worker)).size).toBe(3);

		// /stop on a held run (DSC-39, CHAT-05).
		const held = await h.ask("Hold on fixture:slow fixture-hold-seconds:120");
		await until(async () => (await h.state()).runs.find(r => r.thread === held && r.state === "running"), "the held run", 20_000);
		expect(await h.control("stop", { thread: held })).toEqual({ reply: "Stopping…" });
		await until(() => h.botSaid(held, "⏹️ **Stopped.**"), "the stop", 20_000);

		// SIGTERM mid-run (RUN-18): the worker uploads the session and exits; the lease runs out and the turn fails as lost
		// (RUN-04); the user's next message resumes the uploaded session on a new worker (CHAT-03). The prompt has no
		// fixture marker: only the session's own record brings the fixture back to `slow`, which answers "Resumed in run".
		const evictedThread = await h.ask("Take a while fixture:slow fixture-hold-seconds:120");
		const first = await until(async () => (await h.state()).runs.find(r => r.thread === evictedThread && r.state === "running"), "the run to evict", 20_000);
		const evicted = h.workers.find(w => w.id === first.worker)!;
		await until(() => evicted.output.includes('"fixture holding"'), "the fixture to hold", 20_000);
		evicted.proc.kill("SIGTERM");
		expect(await evicted.proc.exited).toBe(0);
		await until(() => h.botSaid(evictedThread, "❌ **Failed:** the worker running this was lost"), "the lost-worker message", 20_000);
		expect((await h.state()).runs.find(r => r.id === first.id)?.outcome).toBe("lost");

		await h.control("message", { thread: evictedThread, content: "Please continue." });
		const resumed = await until(async () => (await h.state()).runs.find(r => r.continues === first.id && r.outcome === "succeeded"), "the resumed run", 20_000);
		expect(resumed.worker).not.toBe(first.worker);
		await until(() => h.botSaid(evictedThread, "✅ **Done.**"), "the resumed answer", 20_000);
		const bot = (await h.thread(evictedThread)).messages.filter(m => m.bot);
		expect(bot.filter(m => m.content.startsWith("📄 **Answer attached:**")).map(m => m.answer)).toEqual([`Resumed in run ${resumed.id}.`]);
		expect(bot.filter(m => m.content.startsWith("❌ **Failed:**"))).toHaveLength(1);
	}, 90_000);
});
