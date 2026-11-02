/**
 * GET /internal/admin/channels[?refresh=1] — the ask-only channel dropdown of the Settings page (WEB-20 to WEB-23). The
 * orchestrator lists the guild with the stored bot token over Discord's REST API, cached for at most 60 s; `refresh`
 * reloads it. Every channel carries the bot's effective permissions there (WEB-21).
 */

/** WEB-23: shown in place of the dropdown before the bot token and guild id are stored. */
export const CHANNELS_UNCONFIGURED = "Save the Discord bot token and guild id to choose channels";

/** WEB-21: why a channel is shown disabled. */
export const CANT_SEE_CHANNEL = "the bot can't see this channel; add it to the channel";

/** A category, only to group the channels under (WEB-20). */
export interface CategoryChoice {
	id: string;
	name: string;
}

export interface ChannelChoice {
	id: string;
	/** Without the leading `#`. */
	name: string;
	/** Its category, or null at the top level. */
	categoryId: string | null;
	viewable: boolean;
	/** Ask-only channel permissions (WEB-21) the bot lacks, View Channel excluded. */
	missing: string[];
}

export type ChannelListing =
	| { state: "unconfigured"; message: string }
	/** WEB-23: invalid token, Discord unreachable, bot not in the guild (then with the bot's invite link). */
	| { state: "error"; error: string; inviteLink?: string }
	/** Text channels only, uncategorized first, then by category, each in Discord's order; categories in Discord's order. */
	| { state: "ok"; categories: CategoryChoice[]; channels: ChannelChoice[] };
