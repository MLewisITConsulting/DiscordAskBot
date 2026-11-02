import type { Config } from "../../shared/config";
import type { DiscordSurface } from "../discord/surface";
import type { Dispatcher } from "../dispatch/dispatcher";
import type { AgentLog } from "../store/agentlog";
import type { Db } from "../store/db";

/**
 * Everything one engine instance works with (ENG-02: rebuilt on every settings apply). The dispatcher is process-wide
 * and outlives the engine, so an engine restart never touches runs (RUN-09).
 */
export interface EngineDeps {
	config: Config;
	db: Db;
	discord: DiscordSurface;
	dispatcher: Dispatcher;
	agentLog: AgentLog;
	/** Aborted when this engine instance stops: in-flight work detaches from its runs and stops touching Discord. */
	signal: AbortSignal;
}
