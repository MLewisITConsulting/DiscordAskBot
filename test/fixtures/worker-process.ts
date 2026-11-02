// A worker as its own OS process for integration tests: `runWorkerProcess` (as `askbot worker`, SIGTERM included) with
// the fixture agent host and short timings, configured by env. The run-local root is the real one
// (`<tmpdir>/askbot-worker/<pid>`), so tests can check it is gone.
//   ASKBOT_ORCHESTRATOR_URL  internal API base URL
//   TEST_WORKER_TOKEN          the worker token
//   TEST_WORKER_ID             worker id (default `test-worker-<pid>`)
//   TEST_CLAIM_TIMEOUT_MS      claim timeout (default 10000)
//   TEST_DISK_LIMIT            the scratch copy's size limit in bytes (STO-06; default none)
// Prints `{"outcome":…}` on stdout and exits 0, like `askbot worker`.
import { join } from "node:path";
import { runWorkerProcess } from "../../src/worker/main";

const env = process.env;
const orchestratorUrl = env.ASKBOT_ORCHESTRATOR_URL;
const workerToken = env.TEST_WORKER_TOKEN;
if (!orchestratorUrl || !workerToken) throw new Error("ASKBOT_ORCHESTRATOR_URL and TEST_WORKER_TOKEN are required");

const outcome = await runWorkerProcess({
	orchestratorUrl,
	workerToken,
	workerId: env.TEST_WORKER_ID || `test-worker-${process.pid}`,
	claimTimeoutMs: Number(env.TEST_CLAIM_TIMEOUT_MS ?? 10_000),
	identity: { version: "0.0.0-test", hash: "test" },
	ompVersion: "test",
	hostEntry: join(import.meta.dir, "agent-host.ts"),
	timing: {
		heartbeatMs: 100,
		abortKillMs: 400,
		exitGraceMs: 500,
		disconnectWaitMs: 200,
		endAckTimeoutMs: 5_000,
		retryMinMs: 20,
		retryMaxMs: 100,
		diskCheckMs: 100,
	},
	...(env.TEST_DISK_LIMIT ? { diskLimitBytes: Number(env.TEST_DISK_LIMIT) } : {}),
	reconnectMinMs: 30,
	reconnectMaxMs: 200,
});
console.log(JSON.stringify({ outcome }));
process.exit(0);
