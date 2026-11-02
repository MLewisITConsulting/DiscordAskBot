import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFileMentions } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";
import { checkProfileTools, neutraliseMentions } from "../../src/worker/host/session";
import { AGENT_RUN_ENV } from "../../src/worker/host/reap";
import { hostEnv, makeRunDirs } from "../../src/worker/runner";
import { removeStaleWorkerDirs } from "../../src/worker/status";

const temps: string[] = [];
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the agent host's environment is an allowlist (security review F2)", () => {
	test("keeps PATH, locale and proxies, drops ASKBOT_* and omp overrides, sets the run-local dirs and marker", async () => {
		const dirs = await makeRunDirs(temp("askbot-env-"), temp("askbot-env-local-"));
		const saved = { ...process.env };
		try {
			Object.assign(process.env, {
				ASKBOT_WORKER_TOKEN_FILE: "/run/secrets/worker_token",
				ASKBOT_ORCHESTRATOR_URL: "http://orchestrator:8081",
				ASKBOT_SOMETHING_NEW: "x",
				PI_CODING_AGENT_DIR: "/elsewhere",
				OMP_PROFILE: "x",
				ANTHROPIC_API_KEY: "sk-ant",
				HTTPS_PROXY: "http://proxy:3128",
				LC_ALL: "C.UTF-8",
				LANG: "C.UTF-8",
			});
			const env = hostEnv(dirs, "marker-1");
			for (const name of ["ASKBOT_WORKER_TOKEN_FILE", "ASKBOT_ORCHESTRATOR_URL", "ASKBOT_SOMETHING_NEW", "OMP_PROFILE", "ANTHROPIC_API_KEY"]) {
				expect(env[name]).toBeUndefined();
			}
			expect(Object.keys(env).filter(name => name.startsWith("ASKBOT_"))).toEqual([AGENT_RUN_ENV]);
			expect(env).toMatchObject({
				PATH: process.env.PATH,
				HTTPS_PROXY: "http://proxy:3128",
				LC_ALL: "C.UTF-8",
				LANG: "C.UTF-8",
				HOME: dirs.home,
				PI_CODING_AGENT_DIR: dirs.auth,
				TMPDIR: dirs.tmp,
				[AGENT_RUN_ENV]: "marker-1",
			});
			// dry-run's provider keys are passed explicitly.
			expect(hostEnv(dirs, "m", { ANTHROPIC_API_KEY: "sk-ant" }).ANTHROPIC_API_KEY).toBe("sk-ant");
		} finally {
			for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
			Object.assign(process.env, saved);
		}
	});
});

describe("mention neutralising (security review F1)", () => {
	test("omp finds no file mention in neutralised text, which stays readable", () => {
		const text = `Read @/run/secrets/worker_token, (@~/x) "@'a b'" @"c d" a@b\n@./rel`;
		expect(extractFileMentions(text).length).toBeGreaterThan(0);
		expect(extractFileMentions(neutraliseMentions(text))).toEqual([]);
		expect(neutraliseMentions(text).replaceAll("\u2060", "")).toBe(text);
	});
});

describe("the session's tools are exactly the profile's (AGT-09, security review F3)", () => {
	const expected = ["web_search", "list_files", "read_file", "write_file", "yield"];
	test("the same set in any order passes", () => {
		expect(() => checkProfileTools("ask", expected, [...expected].reverse())).not.toThrow();
	});
	test("an extra or a missing tool fails the run", () => {
		expect(() => checkProfileTools("ask", expected, [...expected, "checkpoint"])).toThrow("extra: checkpoint");
		expect(() => checkProfileTools("ask", expected, expected.slice(1))).toThrow("missing: web_search");
	});
});

describe("stale worker directories", () => {
	test("removes numeric dirs of dead processes under each base, keeps live and non-numeric ones", async () => {
		const base = temp("askbot-workers-");
		const runBase = temp("askbot-workers-run-");
		const dead = Bun.spawnSync(["true"]).pid;
		const live = Bun.spawn(["sleep", "30"]);
		try {
			for (const dir of [base, runBase]) {
				mkdirSync(join(dir, String(dead), "auth"), { recursive: true });
				writeFileSync(join(dir, String(dead), "auth", "agent.db"), "tokens");
				mkdirSync(join(dir, String(live.pid)));
				mkdirSync(join(dir, String(process.pid)));
				mkdirSync(join(dir, "notes"));
			}
			const removed = await removeStaleWorkerDirs([base, runBase, base, join(base, "missing")]);
			expect(removed.sort()).toEqual([join(base, String(dead)), join(runBase, String(dead))].sort());
			for (const dir of [base, runBase]) {
				expect(existsSync(join(dir, String(dead)))).toBe(false);
				expect(existsSync(join(dir, String(live.pid)))).toBe(true);
				expect(existsSync(join(dir, String(process.pid)))).toBe(true);
				expect(existsSync(join(dir, "notes"))).toBe(true);
			}
		} finally {
			live.kill();
		}
	});
});
