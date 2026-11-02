import { type APIChannel, type APIGuild, type APIGuildMember, type APIUser, DiscordAPIError, HTTPError, REST, Routes } from "discord.js";

/**
 * A REST-only Discord client for the admin API (WEB-20 to WEB-24): channel listings and permission data work whether or
 * not the engine (and its gateway connection) runs. discord.js's REST handles rate limits.
 */

/** Discord's API root; tests point `api` at `test/fakes/discordRest.ts`. */
export const DISCORD_API = "https://discord.com/api";

export const UNKNOWN_GUILD = 10004;
export const UNKNOWN_MEMBER = 10007;
export const MISSING_ACCESS = 50001;

/** The reads the channel listing needs (WEB-20, WEB-21, WEB-24). */
export interface DiscordRest {
	/** The bot user (401 when the token is invalid). */
	me(): Promise<APIUser>;
	guild(guildId: string): Promise<APIGuild>;
	guildChannels(guildId: string): Promise<APIChannel[]>;
	member(guildId: string, userId: string): Promise<APIGuildMember>;
}

export interface DiscordRestOptions {
	token: string;
	/** Default `DISCORD_API`. */
	api?: string;
	/** Per-request timeout; default 15 s. */
	timeoutMs?: number;
}

/** Discord's JSON error code of a failed REST call, if it has one. */
export function discordErrorCode(err: unknown): number | undefined {
	return err instanceof DiscordAPIError && typeof err.code === "number" ? err.code : undefined;
}

/** The HTTP status of a failed REST call; undefined when Discord was not reached. */
export function discordStatus(err: unknown): number | undefined {
	return err instanceof DiscordAPIError || err instanceof HTTPError ? err.status : undefined;
}

export function createDiscordRest(opts: DiscordRestOptions): DiscordRest {
	const base = new REST({ api: opts.api ?? DISCORD_API, timeout: opts.timeoutMs ?? 15_000, retries: 1 });
	// discord.js drops the token after a 401; set it on every call so a token that works again (Retry) is used again.
	const rest = () => base.setToken(opts.token);

	return {
		me: async () => (await rest().get(Routes.user())) as APIUser,
		guild: async guildId => (await rest().get(Routes.guild(guildId))) as APIGuild,
		guildChannels: async guildId => (await rest().get(Routes.guildChannels(guildId))) as APIChannel[],
		member: async (guildId, userId) => (await rest().get(Routes.guildMember(guildId, userId))) as APIGuildMember,
	};
}
