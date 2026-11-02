import { loadEnv } from "../shared/env";
import { errorMessage, log } from "../shared/log";
import { readTokenFile } from "../shared/tokens";
import { createAdminClient } from "./adminClient";
import { FEATURE_PAGES } from "./pages";
import { startWebServer } from "./server";

/** The web role (architecture §2.2): the admin UI on `ASKBOT_WEB_HOST:ASKBOT_WEB_PORT`, backed by the orchestrator's admin API. */
export async function runWeb(): Promise<void> {
	const env = loadEnv();
	const admin = createAdminClient({ baseUrl: env.orchestratorUrl, token: await readTokenFile(env.webApiTokenFile, "ASKBOT_WEB_API_TOKEN_FILE") });
	const server = startWebServer({
		admin,
		host: env.webHost,
		port: env.webPort,
		pages: FEATURE_PAGES,
		trustedProxies: env.webTrustedProxies,
	});
	log("info", "web started", { url: server.url, orchestrator: env.orchestratorUrl });

	let stopping = false;
	const shutdown = (signal: string) => {
		if (stopping) return;
		stopping = true;
		log("info", "shutting down", { reason: signal });
		server
			.stop()
			.catch(err => log("error", "shutdown failed", { error: errorMessage(err) }))
			.finally(() => {
				log("info", "shutdown complete");
				process.exit(0);
			});
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
