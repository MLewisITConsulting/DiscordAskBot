import type { RESTPostAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

/**
 * The boundary between the engine and discord.js. The engine and the bot logic use only these types;
 * `createDiscordJsConnection` implements them over discord.js, and `createFakeDiscord` (test/fakes) records and drives
 * them in tests.
 */

/** DSC-32 priorities, highest first. */
export type Priority =
	/** New messages, delivery reactions, results and failures. */
	| "high"
	/** State-change edits. */
	| "state"
	/** Activity and heartbeat edits; skipped (not queued) while their channel is rate-limited. */
	| "activity";

export interface MsgRef {
	channelId: string;
	messageId: string;
}

export interface OutFile {
	name: string;
	data: Uint8Array | string;
}

/** Every bot message is sent with all mentions disabled (DSC-07). */
export interface OutMessage {
	/** At most 2000 characters (DSC-14); callers split longer text. */
	content: string;
	files?: OutFile[];
}

/** Outbound operations. Every write goes through the one outbound queue (DSC-32): coalescing, priorities, rate limits. */
export interface DiscordSurface {
	send(channelId: string, msg: OutMessage, priority?: Priority): Promise<MsgRef>;
	/** Reply to a message (e.g. "Not delivered…", RUN-15). */
	reply(to: MsgRef, msg: OutMessage, priority?: Priority): Promise<MsgRef>;
	/**
	 * At most one pending edit per message; a newer edit replaces an unsent one (latest state wins). Resolves when the edit
	 * was applied, superseded or skipped; rejects only when Discord refuses it (e.g. the message was deleted: code 10008).
	 */
	edit(ref: MsgRef, msg: OutMessage, priority: Priority): Promise<void>;
	startThread(from: MsgRef, opts: { name: string; autoArchiveMinutes: 60 | 1440 | 4320 | 10080 }): Promise<string>;
	react(ref: MsgRef, emoji: string): Promise<void>;
	/** Removes the bot's own reaction. */
	unreact(ref: MsgRef, emoji: string): Promise<void>;
	/** null when the message no longer exists. */
	fetchMessage(ref: MsgRef): Promise<{ content: string } | null>;
	/** The channel message a thread was started from (its "top message"), or null. */
	starterMessage(threadId: string): Promise<(MsgRef & { content: string }) | null>;
	/** DSC-29. Throws `MissingPermission` without Change Nickname. */
	setNickname(guildId: string, nickname: string): Promise<void>;
	/** DSC-32 visibility on the status page. */
	queueStats(): { length: number; oldestAgeMs: number | null };
}

/** DSC-29: the bot lacks Change Nickname. */
export class MissingPermission extends Error {
	override name = "MissingPermission";
	constructor(readonly permission: "ChangeNickname", message?: string) {
		super(message ?? `missing Discord permission ${permission}`);
	}
}

// ---------------------------------------------------------------------------
// Inbound events

export interface Actor {
	userId: string;
	username: string;
	/** Guild role ids (empty outside a guild). */
	roleIds: string[];
	isBot: boolean;
}

export interface InAttachment {
	name: string;
	url: string;
	size: number;
	contentType?: string;
}

export interface Where {
	guildId: string | null;
	channelId: string;
	/** For a thread: its parent channel. */
	parentId: string | null;
	isThread: boolean;
}

export interface ReplyOptions extends OutMessage {
	ephemeral?: boolean;
}

/** Interaction responses (Discord's 3 s rule is the adapter's concern: it defers when a handler is slow). */
export interface InteractionResponder {
	reply(msg: ReplyOptions): Promise<void>;
	defer(opts?: { ephemeral?: boolean }): Promise<void>;
	editReply(msg: OutMessage): Promise<void>;
	followUp(msg: ReplyOptions): Promise<void>;
}

/** The two slash commands (DSC-01). */
export type CommandName = "ask" | "stop";

export interface CommandEvent extends InteractionResponder {
	type: "command";
	command: CommandName;
	options: Record<string, string | number | boolean>;
	attachments: InAttachment[];
	actor: Actor;
	where: Where;
}

export interface MessageEvent {
	type: "message";
	ref: MsgRef;
	content: string;
	attachments: InAttachment[];
	actor: Actor;
	where: Where;
}

export type InboundEvent = CommandEvent | MessageEvent;

/** A logged-in Discord session: the surface plus inbound events and lifecycle (one per engine instance). */
export interface DiscordConnection extends DiscordSurface {
	/** Every inbound event; the handler's errors are logged and answered per DSC-08 by the adapter. */
	onEvent(handler: (event: InboundEvent) => void | Promise<void>): () => void;
	/** Called on every ready event (DSC-01, DSC-29), including reconnects. */
	onReady(handler: () => void | Promise<void>): () => void;
	/** Replaces the guild's commands with exactly `commands` (DSC-01). */
	registerCommands(guildId: string, commands: RESTPostAPIApplicationCommandsJSONBody[]): Promise<void>;
	status(): { ready: boolean; user?: string; userId?: string; pingMs?: number };
	/** Throws on a bad token (ENG-03: a login failure ends the engine start in `error`). */
	login(token: string): Promise<void>;
	destroy(): Promise<void>;
}
