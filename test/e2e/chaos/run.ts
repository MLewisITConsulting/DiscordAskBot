#!/usr/bin/env bun
// Chaos tests on the rootless compose stack (implementation.md phase 9; requirements NFR-03 to NFR-05). The stack is
// compose.yaml plus test/e2e/compose/compose.e2e.yaml: the e2e scenario image (test/e2e/k8s/Containerfile) as the
// orchestrator and the workers (the real internals with the fake Discord, kept in a file on the state volume so it
// outlives orchestrator restarts, and the fixture agent host), the real web and launcher. No Discord or model
// credentials are needed.
//   chaos   per seed: ASKS `/ask` threads (fixture runs held 15-60 s) while a seeded RNG crashes the orchestrator, web,
//           the launcher or a worker at random points (a crash is SIGKILL to every process but the container's init, so
//           the restart policy brings the service back; the orchestrator at most once per re-attach grace). The seed
//           fixes the crash times and targets; which run a worker crash hits depends on timing. A turn failed by a lost
//           worker (RUN-04) gets the user's follow-up ("try again"). Asserts every thread ends with exactly one answer,
//           each failure is a lost worker followed by a successful retry, no duplicated Discord message, no run left
//           unfinished, no worker container left.
//   limits  one run fills its scratch past ASKBOT_WORKER_DISK, one OOM-kills its agent host, one OOM-kills a tool
//           process and still answers, one is ordinary: each failure is reported in its own thread only.
//
// Usage: bun test/e2e/chaos/run.ts [chaos] [limits]       (default both, chaos first)
// Env:
//   SEEDS          comma-separated seeds of the chaos rounds (default one random seed; printed)
//   ASKS           `/ask` threads per chaos round (default 4)
//   KILL_MIN_S, KILL_MAX_S  seconds between crashes (default 5, 20)
//   SKIP_BUILD=1   use localhost/askbot:dev and localhost/askbot-e2e:dev as they are on the rootless engine
//   KEEP=1         leave the stack running afterwards
//   ROOTLESS_CONNECTION  Podman connection of the rootless engine (default podman-machine-default; empty = local podman)
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $, type Subprocess } from "bun";

const root = join(import.meta.dir, "..", "..", "..");
const conn = process.env.ROOTLESS_CONNECTION ?? "podman-machine-default";
const baseImage = "localhost/askbot:dev";
const e2eImage = "localhost/askbot-e2e:dev";
const project = "askbot-chaos";
const network = "askbot-chaos";
const workerSecret = "askbot_chaos_worker_token";
const ORCH_PORT = 18181;
const WEB_PORT = 18180;
const LEASE_MS = 10_000;
// Rootless Podman gives a restarted orchestrator a new address: workers notice their dead connection by the
// keepalive (up to 30 s), then may need another 30 s for Bun's DNS cache to let go of the old address. The product
// default re-attach grace, 90 s, covers both.
const REATTACH_GRACE_MS = 90_000;
const ASKS = Number(process.env.ASKS || 4);
const KILL_MIN_S = Number(process.env.KILL_MIN_S || 5);
const KILL_MAX_S = Number(process.env.KILL_MAX_S || 20);
const ROUND_TIMEOUT_MS = 20 * 60_000;
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ["chaos", "limits"];
const seeds = (process.env.SEEDS || String(Math.floor(Math.random() * 1e9))).split(",").map(Number);

const t0 = Date.now();
const stamp = () => `${new Date().toISOString().slice(11, 19)} +${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const say = (msg: string) => console.log(`${stamp()} ${msg}`);
const podman = conn ? ["podman", "--connection", conn] : ["podman"];

/** mulberry32: small, seedable, good enough to pick kill times and targets reproducibly. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A failure `until` does not retry: the round is lost. */
class Fatal extends Error {}

async function until<T>(get: () => Promise<T | undefined | false>, what: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await get().catch(err => {
			if (err instanceof Fatal) throw err;
			return undefined;
		});
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
		await Bun.sleep(1_000);
	}
}

// ---- stack ----------------------------------------------------------------------------------------------------------

const work = await mkdtemp(join(tmpdir(), "askbot-chaos-"));
// The compose provider talks to DOCKER_HOST: the rootless socket, forwarded over the connection's ssh (test/e2e/compose/README.md).
const forward = Bun.spawn(
	[
		"bash",
		"-c",
		'. "$1/test/e2e/compose/rootless-socket.sh" && forward_rootless_socket "$2" "$3" || exit 1; echo "host_sock=$host_sock"; echo "docker_host=$DOCKER_HOST"; echo "forward_pid=$forward_pid"; echo ready; exec sleep 86400',
		"_",
		root,
		conn,
		work,
	],
	{ stdout: "pipe", stderr: "inherit" },
);
const forwardVars: Record<string, string> = {};
{
	const reader = forward.stdout.getReader();
	let text = "";
	while (!text.includes("ready\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the rootless socket forward failed: ${text}`);
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) forwardVars[line.slice(0, eq)] = line.slice(eq + 1);
	}
}

const stackEnv: Record<string, string> = {
	...(process.env as Record<string, string>),
	...(conn ? { CONTAINER_CONNECTION: conn } : {}),
	DOCKER_HOST: forwardVars.docker_host!,
	PODMAN_COMPOSE_WARNING_LOGS: "false",
	ASKBOT_IMAGE: e2eImage,
	ASKBOT_BASE_IMAGE: baseImage,
	ASKBOT_NETWORK: network,
	ASKBOT_WORKER_SECRET: workerSecret,
	ASKBOT_WEB_HOST_PORT: String(WEB_PORT),
	ASKBOT_HOST_PODMAN_SOCKET: forwardVars.host_sock!,
	ASKBOT_SECRETS_DIR: join(work, "secrets"),
	ASKBOT_WORKER_CAPACITY: "4",
	// Small enough for the limits scenario, roomy for the fixture's runs: a worker and its agent host use ~150 MB.
	ASKBOT_WORKER_MEMORY: "512m",
	ASKBOT_WORKER_DISK: "2m",
	E2E_ORCH_PORT: String(ORCH_PORT),
	E2E_ADMIN_PASSWORD: "chaos-admin-password",
	E2E_MAX_CHAT_SESSIONS: "4",
	E2E_LEASE_MS: String(LEASE_MS),
	E2E_REATTACH_GRACE_MS: String(REATTACH_GRACE_MS),
};
const composeArgs = ["compose", "-f", join(root, "compose.yaml"), "-f", join(root, "test", "e2e", "compose", "compose.e2e.yaml"), "-p", project];
const compose = (...args: string[]) => $`${podman} ${composeArgs} ${args}`.env(stackEnv).quiet();
const pm = (...args: string[]) => $`${podman} ${args}`.env(stackEnv).quiet().nothrow();

async function serviceContainer(service: string): Promise<string | undefined> {
	const out = await pm("ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`);
	return out.stdout.toString().trim().split("\n").filter(Boolean)[0];
}
async function workerContainers(all = false): Promise<string[]> {
	// Workers join the stack's worker network, `<ASKBOT_NETWORK>-workers` (compose.yaml).
	const out = await pm("ps", ...(all ? ["-a"] : []), "--filter", "label=askbot.role=worker", "--filter", `network=${network}-workers`, "--format", "{{.Names}}");
	return out.stdout.toString().trim().split("\n").filter(Boolean);
}

/** Workers are removed when they exit: each one's log is followed into the work dir while it lives (`saveLogs`). */
const workerLogs = join(work, "workers");
await mkdir(workerLogs, { recursive: true });
const followers = new Map<string, Subprocess>();
let following = false;
const followWorkers = setInterval(async () => {
	if (following) return;
	following = true;
	for (const name of await workerContainers().catch(() => [])) {
		if (followers.has(name)) continue;
		followers.set(name, Bun.spawn(["sh", "-c", 'exec "$@" >"$0" 2>&1', join(workerLogs, `${name}.log`), ...podman, "logs", "-f", name], { env: stackEnv }));
	}
	following = false;
}, 2_000);

async function teardown(): Promise<void> {
	await compose("down", "-v", "--remove-orphans").nothrow();
	for (const w of await workerContainers(true)) await pm("rm", "-f", w);
	await pm("secret", "rm", workerSecret);
}

async function cleanup(): Promise<void> {
	if (process.env.KEEP) {
		say(`KEEP=1: the stack keeps running. Remove it with: DOCKER_HOST=${stackEnv.DOCKER_HOST} podman ${composeArgs.join(" ")} down -v; podman secret rm ${workerSecret}`);
		return;
	}
	clearInterval(followWorkers);
	for (const follower of followers.values()) follower.kill();
	await teardown();
	if (forwardVars.forward_pid) process.kill(Number(forwardVars.forward_pid));
	forward.kill();
	await rm(work, { recursive: true, force: true });
}

say(`clean state (project ${project}, network ${network})`);
await teardown();
if (!process.env.SKIP_BUILD) {
	say(`build ${baseImage} and ${e2eImage} (rootless)`);
	await $`${podman} build -q -t ${baseImage} ${root}`.quiet();
	await $`${podman} build -q -f ${join(root, "test", "e2e", "k8s", "Containerfile")} --ignorefile ${join(root, "test", "e2e", "k8s", "Containerfile.containerignore")} --build-arg BASE_IMAGE=${baseImage} -t ${e2eImage} ${root}`.quiet();
}
await $`${join(root, "scripts", "init-secrets.sh")}`.env(stackEnv).quiet();
const webToken = (await readFile(join(work, "secrets", "askbot_web_api_token"), "utf8")).trim();
const upStart = Date.now();
await compose("up", "-d");

// ---- clients ----------------------------------------------------------------------------------------------------------

async function control<T>(path: string, body?: object): Promise<T> {
	const res = await fetch(`http://127.0.0.1:${ORCH_PORT}/internal/admin/e2e/${path}`, {
		method: body ? "POST" : "GET",
		headers: { authorization: `Bearer ${webToken}`, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

interface Message {
	id: string;
	bot: boolean;
	content: string;
	files: string[];
}
interface Thread {
	id: string;
	messages: Message[];
}
interface Run {
	id: string;
	thread: string;
	state: string;
	outcome: string | null;
	error: string | null;
	worker: string | null;
	createdAt: string;
}
interface State {
	phase: string;
	runs: Run[];
}

const ANSWER = "📄 **Answer attached:**";
const DONE = "✅ **Done.**";
const FAILED = "❌ **Failed:**";
const LOST = "the worker running this was lost";
const RETRY = "Please try again. fixture:auto";
const botMessages = (t: Thread | undefined) => (t?.messages ?? []).filter(m => m.bot);

async function threads(ids: string[]): Promise<Thread[]> {
	const all = await control<Thread[]>("threads");
	return ids.map(id => all.find(t => t.id === id) ?? { id, messages: [] });
}

async function ask(prompts: string[]): Promise<string[]> {
	const ids: string[] = [];
	for (const prompt of prompts) {
		const { thread, reply } = await control<{ thread: string | null; reply: string | null }>("ask", { prompt });
		if (!thread) throw new Error(`/ask refused: ${reply}`);
		ids.push(thread);
	}
	return ids;
}

await until(async () => (await control<State>("state")).phase === "running", "the engine to run", 180_000);
await until(async () => (await fetch(`http://127.0.0.1:${WEB_PORT}/healthz`)).ok, "web /healthz", 120_000);
say(`stack up in ${((Date.now() - upStart) / 1000).toFixed(0)} s: ${(await pm("ps", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}")).stdout.toString().trim().split("\n").join(", ")}`);

// ---- crashes --------------------------------------------------------------------------------------------------------

const SERVICES = ["orchestrator", "web", "launcher"] as const;
type Target = (typeof SERVICES)[number] | "worker";
interface Kill {
	at: string;
	target: Target;
	container: string;
	downMs?: number;
}

/** The container's state as Podman sees it; undefined once it is gone (a worker is removed when it exits). */
async function containerState(id: string): Promise<{ status: string; startedAt: string } | undefined> {
	const out = await pm("inspect", id, "--format", "{{.State.Status}} {{.State.StartedAt}}");
	if (out.exitCode !== 0) return undefined;
	const [status = "", ...startedAt] = out.stdout.toString().trim().split(" ");
	return { status, startedAt: startedAt.join(" ") };
}

/** Waits until the service's container was started again after the crash and answers; its downtime. */
async function recovered(target: Target, container: string, startedBefore: string, killedAt: number): Promise<number> {
	if (target === "worker") return 0;
	await until(
		async () => {
			// The same container, restarted by its restart policy: a new start time.
			const state = await containerState(container);
			if (state?.status !== "running" || state.startedAt === startedBefore) return false;
			if (target === "orchestrator") return (await control<State>("state")).phase === "running";
			if (target === "web") return (await fetch(`http://127.0.0.1:${WEB_PORT}/healthz`)).ok;
			return (await pm("exec", container, "askbot", "health")).exitCode === 0;
		},
		`${target} to come back`,
		180_000,
	);
	return Date.now() - killedAt;
}

async function chaosMonkey(random: () => number, done: () => boolean, kills: Kill[]): Promise<void> {
	let orchestratorCrashedAt = 0;
	while (!done()) {
		const waitMs = (KILL_MIN_S + random() * (KILL_MAX_S - KILL_MIN_S)) * 1000;
		const pick = random();
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline && !done()) await Bun.sleep(500);
		if (done()) return;
		const targets: Target[] = [...SERVICES, "worker"];
		let target = targets[Math.floor(pick * targets.length)]!;
		let container: string | undefined;
		if (target === "worker") {
			const workers = await workerContainers();
			container = workers[Math.floor(random() * workers.length)];
			// No worker running at this moment: crash the orchestrator instead, the other run-carrying process.
			if (!container) target = "orchestrator";
		}
		// Every orchestrator start graces every lease for the re-attach grace (RUN-07): crashing it again sooner keeps
		// the lease of a run whose worker died alive forever. Web or the launcher go down instead.
		if (target === "orchestrator" && Date.now() - orchestratorCrashedAt < REATTACH_GRACE_MS) target = pick < 0.5 ? "web" : "launcher";
		if (target === "orchestrator") orchestratorCrashedAt = Date.now();
		container ??= await serviceContainer(target);
		if (!container) continue;
		const before = await containerState(container);
		if (before?.status !== "running") continue;
		const at = Date.now();
		// SIGKILL to every process but the container's init (the shell's `kill`: procps' cannot parse `-9 -1`). Not
		// `podman kill`: Podman records that as a stop by the user and never restarts the container, whatever its restart
		// policy; a crash is what restart policies are for. The exec itself fails as its container dies under it, so the
		// crash is judged by the container's state.
		await pm("exec", container, "sh", "-c", "kill -9 -1");
		const crashed = await until(
			async () => {
				const state = await containerState(container);
				return (!state || state.status !== "running" || state.startedAt !== before.startedAt) && "yes";
			},
			`${target} to die`,
			10_000,
		).catch(() => undefined);
		if (!crashed) {
			say(`crash of ${target} ${container.slice(0, 12)} did not take`);
			continue;
		}
		const kill: Kill = { at: new Date(at).toISOString(), target, container: container.slice(0, 20) };
		kills.push(kill);
		say(`💥 crashed ${target} (${kill.container})`);
		kill.downMs = await recovered(target, container, before.startedAt, at);
		if (target !== "worker") say(`   ${target} back after ${(kill.downMs / 1000).toFixed(1)} s`);
	}
}

// ---- one thread's flow ------------------------------------------------------------------------------------------------

interface Flow {
	thread: string;
	startedAt: number;
	doneAt?: number;
	/** Follow-ups sent after a turn failed on a lost worker (RUN-04). */
	retries: number;
	retriedAt?: number;
}

/** One step of a thread's flow; true once it is answered and its run finished. */
async function step(f: Flow, t: Thread, runs: Run[]): Promise<boolean> {
	const messages = t.messages;
	const lastStatus = messages.findLastIndex(m => m.bot && (m.content.startsWith(DONE) || m.content.startsWith(FAILED)));
	const status = messages[lastStatus];
	const open = runs.some(r => r.thread === f.thread && !["finished", "lost"].includes(r.state));
	if (status?.content.startsWith(DONE) && !open) {
		f.doneAt ??= Date.now();
		return true;
	}
	if (!status?.content.startsWith(FAILED)) return false;
	if (!status.content.includes(LOST)) throw new Fatal(`thread ${f.thread} failed: ${status.content}`);
	// RUN-04: the user's way on is to ask again in the thread. Again after a while if the message was lost in a crash.
	const followed = messages.slice(lastStatus + 1).some(m => !m.bot);
	if (open || (followed && f.retriedAt && Date.now() - f.retriedAt < 30_000)) return false;
	say(`   ${f.thread}: turn failed on a lost worker (RUN-04); asking again`);
	await control("message", { thread: f.thread, content: RETRY }).catch(err => say(`   ${f.thread}: follow-up: ${err}`));
	f.retries++;
	f.retriedAt = Date.now();
	return false;
}

/** Fingerprint of a bot message for duplicate detection: its text without the volatile parts. */
const fingerprint = (content: string) => content.replace(/\b[0-9a-f]{7,40}\b/g, "<id>").replace(/\d+(\.\d+)?\s?(s|ms|min|m)\b/g, "<t>").replace(/\$\d+(\.\d+)?/g, "<$>");

interface Check {
	ok: boolean;
	line: string;
}

/**
 * Every thread answered once (one `answer.md`, the last status "Done"), every failure a lost worker, no bot message
 * repeated more often than the thread had turns (`retries` + 1; a turn posts its own status message), then no run
 * unfinished and no worker container left.
 */
async function verify(flows: Flow[]): Promise<Check[]> {
	const checks: Check[] = [];
	const check = (ok: boolean, line: string) => checks.push({ ok, line: `${ok ? "ok  " : "FAIL"} ${line}` });
	const views = await threads(flows.map(f => f.thread));
	for (const [i, t] of views.entries()) {
		const f = flows[i]!;
		const bot = botMessages(t);
		const answers = bot.filter(m => m.content.startsWith(ANSWER) && m.files.includes("answer.md"));
		check(answers.length === 1, `${t.id}: exactly one answer.md (${answers.length})`);
		const statuses = bot.filter(m => m.content.startsWith(DONE) || m.content.startsWith(FAILED));
		check(statuses.at(-1)?.content.startsWith(DONE) === true, `${t.id}: ends with "Done" (${statuses.map(m => m.content.split("\n")[0]!.slice(0, 40)).join(" → ")})`);
		const failures = statuses.filter(m => m.content.startsWith(FAILED));
		check(
			failures.every(m => m.content.includes(LOST)) && failures.length <= f.retries,
			`${t.id}: ${failures.length} failure(s), all lost workers, each followed by a retry (${f.retries} follow-up(s))`,
		);
		const turns = f.retries + 1;
		const counts = new Map<string, number>();
		for (const m of bot) counts.set(fingerprint(m.content), (counts.get(fingerprint(m.content)) ?? 0) + 1);
		const repeated = [...counts].filter(([print, n]) => n > (print.startsWith(ANSWER) || print.startsWith(DONE) ? 1 : turns));
		check(
			repeated.length === 0,
			`${t.id}: no duplicated Discord message (${bot.length} bot messages, ${turns} turn(s)${repeated.length ? `; repeated: ${repeated.map(([p, n]) => `${n}× ${JSON.stringify(p.slice(0, 80))}`).join(", ")}` : ""})`,
		);
	}
	const state = await control<State>("state");
	const open = state.runs.filter(r => !["finished", "lost"].includes(r.state));
	check(open.length === 0, `no run left unfinished (${open.map(r => `${r.thread}/${r.state}`).join(", ") || "none"})`);
	const left = await until(async () => (await workerContainers(true)).length === 0 && "none", "worker containers to go", 120_000).catch(async () => (await workerContainers(true)).join(", "));
	check(left === "none", `no worker container left (${left})`);
	return checks;
}

const results: string[] = [];
let failed = false;

async function chaosRound(seed: number): Promise<void> {
	const random = rng(seed);
	say(`== chaos round, seed ${seed}: ${ASKS} /ask threads, a crash every ${KILL_MIN_S}-${KILL_MAX_S} s`);
	const holds = Array.from({ length: ASKS }, () => 15 + Math.floor(random() * 45));
	const started = Date.now();
	const ids = await ask(holds.map((hold, i) => `Chaos question ${i + 1}. fixture:slow fixture-hold-seconds:${hold}`));
	say(`asked ${ids.map((id, i) => `${id} (holds ${holds[i]} s)`).join(", ")}`);
	const flows: Flow[] = ids.map(thread => ({ thread, startedAt: started, retries: 0 }));
	const kills: Kill[] = [];
	let finished = false;
	const monkey = chaosMonkey(random, () => finished, kills);
	let lastLine = "";
	try {
		await until(
			async () => {
				const views = await threads(ids).catch(() => undefined);
				const state = await control<State>("state").catch(() => undefined);
				if (!views || !state) return false;
				const line = views
					.map(t => {
						const run = state.runs.filter(r => r.thread === t.id).at(-1);
						return `${t.id}:${run ? `${run.state}${run.outcome ? `/${run.outcome}` : ""}` : "-"}`;
					})
					.join(" ");
				if (line !== lastLine) say(`   ${line}`);
				lastLine = line;
				let all = true;
				for (const [i, t] of views.entries()) all = (await step(flows[i]!, t, state.runs)) && all;
				return all;
			},
			"every thread to be answered",
			ROUND_TIMEOUT_MS,
		);
	} finally {
		finished = true;
		await monkey;
	}
	const totalS = ((Date.now() - started) / 1000).toFixed(0);
	const killList = kills.map(k => `${k.target}@+${((Date.parse(k.at) - started) / 1000).toFixed(0)}s${k.downMs ? `(back in ${(k.downMs / 1000).toFixed(1)}s)` : ""}`).join(", ");
	say(`all answered in ${totalS} s; ${kills.length} crashes: ${killList || "none"}`);
	for (const f of flows) say(`   ${f.thread}: answered after ${(((f.doneAt ?? Date.now()) - f.startedAt) / 1000).toFixed(0)} s${f.retries ? `, ${f.retries} follow-up(s) after a lost worker (RUN-04)` : ""}`);
	// The threads just finished; give the last Discord writes and worker removals a moment.
	await Bun.sleep(5_000);
	const checks = await verify(flows);
	for (const c of checks) say(`   ${c.line}`);
	const bad = checks.filter(c => !c.ok).length;
	if (bad) {
		failed = true;
		await saveLogs();
	}
	const retries = flows.reduce((n, f) => n + f.retries, 0);
	results.push(`chaos seed ${seed}: ${bad ? `FAIL (${bad} checks)` : "PASS"}, ${ASKS} threads in ${totalS} s, ${retries} follow-up(s) after lost workers, ${kills.length} crashes: ${killList}`);
}

async function limitsRound(): Promise<void> {
	say("== limits round: a full scratch disk, an OOM-killed agent host, an OOM-killed tool process, an ordinary question");
	const started = Date.now();
	const [disk, oomHost, oomChild, plain] = await ask([
		"Please fill the disk. fixture:fillDisk",
		"Please use too much memory. fixture:oomHost",
		"Please run a memory hog. fixture:oomChild",
		"Please answer. fixture:auto",
	]);
	say(`asked disk ${disk}, oomHost ${oomHost}, oomChild ${oomChild}, plain ${plain}`);
	const ids = [disk!, oomHost!, oomChild!, plain!];
	const statusOf = (t: Thread) => botMessages(t).findLast(m => m.content.startsWith(DONE) || m.content.startsWith(FAILED))?.content.split("\n")[0] ?? "-";
	let lastLine = "";
	await until(
		async () => {
			const views = await threads(ids);
			const line = views.map(t => `${t.id}:${statusOf(t).slice(0, 30)}`).join(" ");
			if (line !== lastLine) say(`   ${line}`);
			lastLine = line;
			const state = await control<State>("state");
			return views.every(t => statusOf(t) !== "-") && state.runs.every(r => ["finished", "lost"].includes(r.state));
		},
		"the limits round",
		10 * 60_000,
	);
	const totalS = ((Date.now() - started) / 1000).toFixed(0);
	const views = await threads(ids);
	const checks: Check[] = [];
	const check = (ok: boolean, line: string) => checks.push({ ok, line: `${ok ? "ok  " : "FAIL"} ${line}` });
	const text = (id: string) =>
		botMessages(views.find(t => t.id === id))
			.map(m => m.content)
			.join("\n");
	const answered = (id: string) => botMessages(views.find(t => t.id === id)).filter(m => m.files.includes("answer.md")).length;
	const oomWarning = "ran out of memory during this turn";
	const failure = (id: string) => text(id).split("\n").find(l => l.startsWith(FAILED)) ?? "(no failure)";
	check(/ran out of disk space/.test(failure(disk!)) && answered(disk!) === 0, `disk ${disk}: ${failure(disk!)}`);
	check(/most likely ran out of memory/.test(failure(oomHost!)) && answered(oomHost!) === 0, `oomHost ${oomHost}: ${failure(oomHost!)}`);
	check(answered(oomChild!) === 1 && text(oomChild!).includes(oomWarning) && !text(oomChild!).includes(FAILED), `oomChild ${oomChild}: answered with the OOM warning (AGT-19)`);
	check(answered(plain!) === 1 && !text(plain!).includes(oomWarning) && !text(plain!).includes(FAILED) && !/out of (disk|memory)/.test(text(plain!)), `plain ${plain}: answered, no OOM or disk report`);
	for (const [name, id] of [["disk", disk], ["oomHost", oomHost]] as const) {
		check(!text(id!).includes(oomWarning) && (name === "disk" ? !/memory/.test(failure(id!)) : !/disk/.test(failure(id!))), `${name} ${id}: only its own failure reported`);
	}
	const left = await until(async () => (await workerContainers(true)).length === 0 && "none", "worker containers to go", 120_000).catch(async () => (await workerContainers(true)).join(", "));
	check(left === "none", `no worker container left (${left})`);
	for (const c of checks) say(`   ${c.line}`);
	const bad = checks.filter(c => !c.ok).length;
	if (bad) {
		failed = true;
		await saveLogs();
	}
	results.push(`limits: ${bad ? `FAIL (${bad} checks)` : "PASS"} in ${totalS} s`);
}

/** Every service's whole log and the orchestrator's run history, kept after the stack is gone. */
async function saveLogs(): Promise<void> {
	const logs = await mkdtemp(join(tmpdir(), "askbot-chaos-logs-"));
	for (const s of ["orchestrator", "web", "launcher"]) {
		await Bun.write(join(logs, `${s}.log`), (await compose("logs", "--no-color", "--timestamps", s).nothrow()).stdout);
	}
	await Bun.write(join(logs, "state.json"), JSON.stringify(await control<State>("state").catch(e => ({ error: String(e) })), null, 1));
	await Bun.write(join(logs, "threads.json"), JSON.stringify(await control<Thread[]>("threads").catch(e => ({ error: String(e) })), null, 1));
	await cp(workerLogs, join(logs, "workers"), { recursive: true });
	say(`logs in ${logs}`);
}

try {
	if (scenarios.includes("chaos")) for (const seed of seeds) await chaosRound(seed);
	if (scenarios.includes("limits")) await limitsRound();
} catch (err) {
	failed = true;
	say(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
	await saveLogs();
} finally {
	console.log("\n=== results ===");
	for (const r of results) console.log(r);
	await cleanup();
}
process.exit(failed ? 1 : 0);
