import { DISCORD_API } from "../discord/rest";
import type { OmpUpdater } from "../omp/updates";
import { type Accounts, createAccounts, ompSigninBackend, type SigninBackend } from "../store/accounts";
import type { AgentLog } from "../store/agentlog";
import type { Signins } from "../store/signins";
import type { Vault } from "../store/vault";
import type { RollingFiles } from "../../shared/rollinglog";
import type { Settings } from "../../shared/config";
import { type ChannelCheck, createChannelDirectory, createChannelsRoutes } from "./channels";
import type { AdminRoutes } from "./http";
import { createLogsRoutes } from "./logs";
import { createModelsRoutes } from "./models";
import { createOmpRoutes } from "./omp";
import { createSkillsRoutes } from "./skills";

/**
 * The admin UI's feature endpoints (requirements §5.3) and the hooks the built-in admin API needs from them, composed in
 * one place so the orchestrator and the end-to-end tests mount exactly the same set. External services are reached
 * through `discordApi` and `signinBackend`, which default to the real ones.
 */

export interface AdminFeatureDeps {
	vault: Vault;
	signins: Signins;
	agentLog: AgentLog;
	processLog: RollingFiles;
	stateDir: string;
	ompDir: string;
	/** In-place omp updates: the omp page's update panel, "Check now" and "Approve update" (WEB-33). */
	ompUpdates: Pick<OmpUpdater, "status" | "check" | "install">;
	/** Discord's API root; default the public API. */
	discordApi?: string;
	/** omp's provider sign-ins; default omp's own (SEC-12). */
	signinBackend?: SigninBackend;
}

export interface AdminFeatures {
	routes: AdminRoutes;
	accounts: Accounts;
	/** WEB-24: the save-time check of the configured ask-only channels. */
	checkChannels(settings: Settings): Promise<ChannelCheck>;
	/** Model sign-ins, for the home page's count. */
	modelAccounts(): number;
}

export function createAdminFeatures(deps: AdminFeatureDeps): AdminFeatures {
	const channels = createChannelDirectory({ vault: deps.vault, discordApi: deps.discordApi ?? DISCORD_API });
	const accounts = createAccounts({ signins: deps.signins, backend: deps.signinBackend ?? ompSigninBackend(deps.signins, deps.stateDir) });
	return {
		routes: {
			...createSkillsRoutes({ ompDir: deps.ompDir }),
			...createLogsRoutes({ agentLog: deps.agentLog, processLog: deps.processLog }),
			...createModelsRoutes(accounts),
			...createOmpRoutes({ vault: deps.vault, updates: deps.ompUpdates }),
			...createChannelsRoutes(channels),
		},
		accounts,
		checkChannels: settings => channels.check(settings),
		modelAccounts: () => deps.signins.authStorage.credentials.list().length,
	};
}
