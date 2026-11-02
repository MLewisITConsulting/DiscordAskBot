import { describe, expect, test } from "bun:test";
import { loadEnv } from "../../src/shared/env";

describe("security settings in the environment (requirements §13)", () => {
	test("ASKBOT_WEB_TRUSTED_PROXIES takes addresses and CIDRs and rejects anything else", () => {
		expect(loadEnv({}).webTrustedProxies).toEqual([]);
		expect(loadEnv({ ASKBOT_WEB_TRUSTED_PROXIES: " 10.0.0.0/8, fd00::/8,192.0.2.1 " }).webTrustedProxies).toEqual(["10.0.0.0/8", "fd00::/8", "192.0.2.1"]);
		for (const bad of ["proxy.local", "10.0.0.0/33", "fd00::/129", "10.0.0.0/8/1", "10.0.0.0/x"]) {
			expect(() => loadEnv({ ASKBOT_WEB_TRUSTED_PROXIES: bad })).toThrow("ASKBOT_WEB_TRUSTED_PROXIES");
		}
	});

	test("ASKBOT_WORKER_ADDRESS_BINDING is on unless turned off", () => {
		expect(loadEnv({}).workerAddressBinding).toBe(true);
		expect(loadEnv({ ASKBOT_WORKER_ADDRESS_BINDING: "off" }).workerAddressBinding).toBe(false);
		expect(() => loadEnv({ ASKBOT_WORKER_ADDRESS_BINDING: "maybe" })).toThrow("ASKBOT_WORKER_ADDRESS_BINDING");
	});

	test("ASKBOT_WORKER_CPUS defaults to 2 and takes whole or fractional CPUs (F7)", () => {
		expect(loadEnv({}).workerCpus).toBe(2);
		expect(loadEnv({ ASKBOT_WORKER_CPUS: "1.5" }).workerCpus).toBe(1.5);
		expect(loadEnv({ ASKBOT_WORKER_CPUS: "0.01" }).workerCpus).toBe(0.01);
		for (const bad of ["0", "0.001", "-1", "two", "1,5", "2000"]) {
			expect(() => loadEnv({ ASKBOT_WORKER_CPUS: bad })).toThrow("ASKBOT_WORKER_CPUS");
		}
	});
});
