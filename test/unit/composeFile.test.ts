import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** `compose.yaml` as the compose providers read it (YAML merge keys resolved; `${…}` left as written). */
interface Service {
	image?: string;
	command?: string[];
	networks?: string[];
	volumes?: string[];
	environment?: Record<string, string>;
	healthcheck?: { test: string[]; interval: string; timeout: string; start_period: string; retries: number };
}
interface ComposeFile {
	services: Record<string, Service>;
	networks: Record<string, { name: string; driver_opts?: Record<string, string> }>;
}

const compose = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "..", "..", "compose.yaml")).text()) as ComposeFile;

describe("compose.yaml", () => {
	test("every service health check matches OBS-01: every 30 s, timeout 5 s, start period 30 s, 3 retries", () => {
		expect(Object.keys(compose.services).sort()).toEqual(["launcher", "orchestrator", "web"]);
		for (const service of Object.values(compose.services)) {
			const { test: probe, ...timings } = service.healthcheck ?? { test: [] };
			expect(probe[0]).toBe("CMD");
			expect(timings).toEqual({ interval: "30s", timeout: "5s", start_period: "30s", retries: 3 });
		}
	});

	test("workers get their own isolated network that only the orchestrator shares (F6, SEC-15)", () => {
		expect(compose.networks).toEqual({
			askbot: { name: "${ASKBOT_NETWORK:-askbot}" },
			workers: { name: "${ASKBOT_NETWORK:-askbot}-workers", driver_opts: { isolate: "strict" } },
		});
		expect(compose.services.orchestrator?.networks).toEqual(["askbot", "workers"]);
		expect(compose.services.web?.networks).toEqual(["askbot"]);
		expect(compose.services.launcher?.networks).toEqual(["askbot"]);
		// The launcher attaches workers to the workers network, by its fixed name.
		expect(compose.services.launcher?.environment?.ASKBOT_WORKER_NETWORK).toBe(compose.networks.workers?.name);
	});

	test("one image for every service and the workers; web keeps nothing; workers get 2g of scratch by default", () => {
		const image = "${ASKBOT_IMAGE:-ghcr.io/mlewisitconsulting/askbot:latest}";
		for (const [name, service] of Object.entries(compose.services)) {
			expect(service.image).toBe(image);
			expect(service.command).toEqual([name]);
		}
		expect(compose.services.launcher?.environment?.ASKBOT_IMAGE).toBe(image);
		// DB-03: no volume for web; only the orchestrator has state.
		expect(compose.services.web?.volumes).toBeUndefined();
		expect(compose.services.orchestrator?.volumes).toEqual(["askbot-state:/state"]);
		expect(compose.services.launcher?.environment?.ASKBOT_WORKER_DISK).toBe("${ASKBOT_WORKER_DISK:-2g}");
	});
});
