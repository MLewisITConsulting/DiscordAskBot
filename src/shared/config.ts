import { z } from "zod";

const configObject = z.object({
	discord: z
		.object({
			guildId: z.string().min(1),
			allowedUserIds: z.array(z.string()).default([]),
			allowedRoleIds: z.array(z.string()).default([]),
			/**
			 * Ask-only channels: anyone may run `/ask` there (DSC-03). Required to start the engine, not to save: a fresh
			 * install stores the bot token first, then picks channels from the dropdown (WEB-20, ENG-02).
			 */
			askChannelIds: z.array(z.string().min(1)).default([]),
		})
		.refine(d => d.allowedUserIds.length + d.allowedRoleIds.length > 0, {
			message: "at least one of allowedUserIds/allowedRoleIds must be non-empty",
		}),
	agent: z.object({ name: z.string().min(1).max(32).default("AskBot") }).prefault({}),
	models: z
		.object({
			ask: z.string().min(1).optional(),
			thinking: z.enum(["auto", "inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("high"),
		})
		.prefault({}),
	limits: z
		.object({
			maxChatSessions: z.number().int().positive().default(2),
			maxCostUsdPerTurn: z.number().positive().default(15),
			chatIdleMinutes: z.number().positive().default(30),
		})
		.prefault({}),
	workers: z
		.object({
			/** Unset = worker capacity. Never rejected here; health warns when it exceeds capacity (RUN-10). */
			maxConcurrentRuns: z.number().int().positive().optional(),
			reattachGraceSeconds: z.number().int().positive().default(90),
		})
		.prefault({}),
	logs: z.object({ maxGiB: z.number().min(0.1).default(5) }).prefault({}),
	omp: z.object({ autoUpdate: z.boolean().default(false) }).prefault({}),
});

const configSchema = configObject.superRefine((config, ctx) => {
	const seen = new Set<string>();
	config.discord.askChannelIds.forEach((id, i) => {
		if (seen.has(id)) ctx.addIssue({ code: "custom", path: ["discord", "askChannelIds", i], message: `duplicate channel ${id}` });
		seen.add(id);
	});
});

const secretsSchema = z.object({
	discordToken: z.string().min(1),
	providerKeys: z.record(z.string(), z.string()).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type Secrets = z.infer<typeof secretsSchema>;

/** The engine starts only with at least one ask-only channel (ENG-02). */
export function hasAskChannel(config: Config): boolean {
	return config.discord.askChannelIds.length > 0;
}

/** ENG-02: why the engine stays `unconfigured` after the first save. */
export const ASK_CHANNEL_MISSING = "Add an ask-only channel in Settings (Discord) to start the engine.";

/** Everything an admin enters (requirements §9); stored encrypted in the vault. */
export interface Settings {
	config: Config;
	secrets: Secrets;
}

/** One settings error: where it is (`secrets.*` paths start with "secrets") and its `Invalid config: <path>: <message>` text. */
export interface SettingsIssue {
	path: (string | number)[];
	message: string;
}

/** Its message is the first issue's (requirements §9); `issues` holds every one, for editors that mark each field. */
export class ConfigError extends Error {
	override name = "ConfigError";
	constructor(readonly issues: SettingsIssue[]) {
		super(issues[0]!.message);
	}
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, prefix: (string | number)[]): T {
	const result = schema.safeParse(value);
	if (result.success) return result.data;
	throw new ConfigError(
		result.error.issues.map(issue => {
			const path = [...prefix, ...issue.path.map(p => (typeof p === "number" ? p : String(p)))];
			return { path, message: `Invalid config: ${path.length ? path.join(".") : "(root)"}: ${issue.message}` };
		}),
	);
}

/** Validate an already-parsed config object (everything in requirements §9 except `secrets.*`). */
export function parseConfig(raw: unknown): Config {
	return parseOrThrow(configSchema, raw, []);
}

/** Validate `secrets.*`; errors carry the `secrets.` path prefix. */
export function parseSecrets(raw: unknown): Secrets {
	return parseOrThrow(secretsSchema, raw, ["secrets"]);
}

export function parseSettings(raw: { config: unknown; secrets: unknown }): Settings {
	return { config: parseConfig(raw.config), secrets: parseSecrets(raw.secrets) };
}

/** Discord authorization: user id in `allowedUserIds` or any role in `allowedRoleIds`. */
export function isAllowedMember(config: Config, userId: string, roleIds: Iterable<string>): boolean {
	if (config.discord.allowedUserIds.includes(userId)) return true;
	for (const role of roleIds) if (config.discord.allowedRoleIds.includes(role)) return true;
	return false;
}

/** True when `channelId` is one of the ask-only channels (`discord.askChannelIds`). */
export function isAskChannel(config: Config, channelId: string | null | undefined): boolean {
	return !!channelId && config.discord.askChannelIds.includes(channelId);
}
