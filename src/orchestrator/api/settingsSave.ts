import type { SettingsSaveResponse } from "../../shared/adminApi";
import { ConfigError, parseSettings, type Settings, type SettingsIssue } from "../../shared/config";
import type { Controller } from "../engine/controller";
import type { Vault } from "../store/vault";
import type { ChannelCheck } from "./channels";
import { healthLimits } from "./health";

/** The Settings page save (ENG-02): requirements §9 and WEB-24. */

export interface SettingsSaveDeps {
	vault: Pick<Vault, "writeSettings">;
	controller: Pick<Controller, "apply" | "status">;
	workerCapacity: number;
	/** WEB-24; omitted, channels are not checked. */
	checkChannels?: (settings: Settings) => Promise<ChannelCheck>;
}

/** A refused save: `message` is what the Settings page shows, `issues` locate every error in the settings. */
export class SettingsRejected extends Error {
	override name = "SettingsRejected";
	constructor(
		message: string,
		readonly issues: SettingsIssue[],
	) {
		super(message);
	}
}

/**
 * Validates `raw` (secrets already resolved), stores it and applies it (ENG-02); throws `SettingsRejected`. The result
 * carries the channel check's warnings (WEB-24) and the concurrency warnings (RUN-10: never blocking).
 */
export async function storeSettings(deps: SettingsSaveDeps, raw: { config: unknown; secrets: unknown }): Promise<SettingsSaveResponse> {
	let settings: Settings;
	try {
		settings = parseSettings(raw);
	} catch (err) {
		if (err instanceof ConfigError) throw new SettingsRejected(err.message, err.issues);
		throw err;
	}
	const channels = (await deps.checkChannels?.(settings)) ?? { errors: [], warnings: [] };
	if (channels.errors.length) throw new SettingsRejected(channels.errors.map(e => e.message).join(" "), channels.errors);
	deps.vault.writeSettings(settings);
	await deps.controller.apply();
	const { phase, error } = deps.controller.status();
	return { phase, error, warnings: [...channels.warnings, ...healthLimits(settings.config, deps.workerCapacity).warnings] };
}
