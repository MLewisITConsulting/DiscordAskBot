import { Settings } from "@oh-my-pi/pi-coding-agent";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { z } from "zod";
import { errorMessage } from "./log";

/**
 * omp configuration managed from the admin UI (AGT-20): setting overrides applied to every agent session. Stored
 * encrypted in the vault next to the AskBot settings; read at the start of every agent run, so a save takes effect
 * without restarting the engine (AGT-23).
 */

/** Settings AskBot relies on to run headless; admins cannot override them. */
export const LOCKED_SETTINGS: Record<string, { value: unknown; reason: string }> = {
	"tools.approvalMode": { value: "yolo", reason: "There is no one at a terminal to approve tool calls; AskBot controls risk with the confined ask tools (AGT-09)." },
	"ask.timeout": { value: 0, reason: "The agent never asks the user questions; the ask tool is not exposed (AGT-09)." },
	"async.enabled": { value: false, reason: "Subagents must finish inside the turn so their usage and limits count (AGT-32)." },
};

const ompConfigSchema = z.object({
	settings: z.record(z.string(), z.unknown()).default({}),
});

export interface OmpConfig {
	/** Setting id → value, as accepted by omp `Settings.isolated`. */
	settings: Record<string, unknown>;
}

/** `path` locates the error in the `{ settings }` object when it is about one field. */
export class OmpConfigError extends Error {
	override name = "OmpConfigError";
	constructor(
		message: string,
		readonly path?: (string | number)[],
	) {
		super(message);
	}
}

export function emptyOmpConfig(): OmpConfig {
	return { settings: {} };
}

/** One omp setting as shown in the admin UI. */
export interface SettingInfo {
	id: string;
	type: "boolean" | "number" | "string" | "enum" | "array" | "record";
	default: unknown;
	enumValues?: readonly string[];
	label?: string;
	description?: string;
	/** Never render the value back. */
	credential: boolean;
	/** Set when AskBot pins this setting. */
	locked?: string;
}

/** Every omp setting with its type, default and description (550+ as of omp 18.12.1). */
export function listSettings(): SettingInfo[] {
	return orderedSettings().map(setting => {
		const { definition } = setting;
		const ui = definition.ui;
		return {
			id: setting.id,
			type: definition.type,
			default: definition.default,
			...(setting.enumValues ? { enumValues: setting.enumValues } : {}),
			...(ui?.label ? { label: ui.label } : {}),
			...(ui?.description ? { description: ui.description } : {}),
			credential: setting.isCredential,
			...(LOCKED_SETTINGS[setting.id] ? { locked: LOCKED_SETTINGS[setting.id]!.reason } : {}),
		};
	});
}

/**
 * Parses form text for one setting with omp's own parser (booleans as true/false/yes/no, numbers, enum
 * values, JSON for arrays and records). Throws `OmpConfigError` naming the setting.
 */
export function parseSettingValue(id: string, text: string): unknown {
	const setting = lookup(id);
	if (!setting) throw new OmpConfigError(`Unknown omp setting "${id}"`, ["settings", id]);
	if (LOCKED_SETTINGS[id]) throw new OmpConfigError(`${id} is managed by AskBot: ${LOCKED_SETTINGS[id]!.reason}`, ["settings", id]);
	try {
		const value = setting.definition.type === "array" || setting.definition.type === "record" ? JSON.parse(text) : setting.parse(text);
		setting.assertWritable(value);
		return value;
	} catch (err) {
		throw new OmpConfigError(`${id}: ${errorMessage(err)}`, ["settings", id]);
	}
}

/** Validates a whole config (also as omp would load it) and returns it normalized. */
export function parseOmpConfig(raw: unknown): OmpConfig {
	const result = ompConfigSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0]!;
		const path = issue.path.map(p => (typeof p === "number" ? p : String(p)));
		throw new OmpConfigError(`Invalid omp config: ${path.join(".") || "(root)"}: ${issue.message}`, path);
	}
	for (const id of Object.keys(result.data.settings)) {
		if (LOCKED_SETTINGS[id]) throw new OmpConfigError(`${id} is managed by AskBot: ${LOCKED_SETTINGS[id]!.reason}`, ["settings", id]);
		if (!lookup(id)) throw new OmpConfigError(`Unknown omp setting "${id}"`, ["settings", id]);
	}
	try {
		Settings.isolated(sessionSettings(result.data));
	} catch (err) {
		throw new OmpConfigError(`Invalid omp settings: ${errorMessage(err)}`);
	}
	return result.data;
}

/** The record passed to `Settings.isolated`: admin overrides, then AskBot's pinned values on top. */
export function sessionSettings(config: OmpConfig): Record<string, unknown> {
	const pinned = Object.fromEntries(Object.entries(LOCKED_SETTINGS).map(([id, { value }]) => [id, value]));
	return { "compaction.enabled": true, "retry.enabled": true, ...config.settings, ...pinned };
}

/**
 * Initializes omp's process-global settings with the admin overrides and returns them for the session.
 *
 * omp's `web_search` (and `executeBash`) read the global `settings` object, which only exists after
 * `Settings.init()`; a session created with `Settings.isolated` never sets it, so every `web_search` call threw
 * "Settings not initialized". In-memory: omp writes nothing. `cwd` is a AskBot-owned directory with no
 * project config, matching `isolated`, which loads no project layer.
 *
 * One run per agent process is the invariant: `Settings.init` returns the first call's settings to every later
 * caller, so a second run would silently keep the first run's overrides. Hence the throw.
 */
export async function initRunSettings(config: OmpConfig, agentDir: string): Promise<Settings> {
	if (Settings.current) throw new Error("omp settings are already initialized in this process; one agent run per process");
	return Settings.init({ inMemory: true, agentDir, cwd: agentDir, overrides: sessionSettings(config) });
}
