import { errorMessage, log } from "../../shared/log";
import type { AskChat } from "../engine/chat";
import type { EngineDeps } from "../engine/deps";
import { type AccessRefusal, askAccess, refusalMessage, stopAccess } from "./access";
import { commandDefinitions } from "./commands";
import { type CommandEvent, type DiscordConnection, type MessageEvent, MissingPermission } from "./surface";

export interface BotOptions {
	deps: EngineDeps;
	connection: DiscordConnection;
	/** `/ask`, `/stop` and messages in ask threads (CHAT-03 to CHAT-11, DSC-39). */
	askChat: AskChat;
}

export interface BotHandle {
	/** Stops handling events (engine stop). */
	detach(): void;
	/** DSC-29: why the nickname could not be set at the last ready event, for the status page; undefined when it was set. */
	nicknameWarning(): string | undefined;
}

/**
 * Wires `/ask`, `/stop` and thread messages onto a Discord connection (requirements §3). Attach before `login`: commands
 * and the nickname are set at every ready event (DSC-01, DSC-29). Unhandled errors propagate to the connection, which
 * logs them and answers `Error: <message>` (DSC-08).
 */
export function attachBot({ deps, connection, askChat }: BotOptions): BotHandle {
	const { config } = deps;
	const agentName = config.agent.name;
	const guildId = config.discord.guildId;
	let nicknameWarning: string | undefined;

	async function onReady(): Promise<void> {
		// Replaces the guild's whole command list, so removed or renamed commands disappear at every start.
		await connection.registerCommands(guildId, commandDefinitions(agentName));
		try {
			await connection.setNickname(guildId, agentName);
			nicknameWarning = undefined;
		} catch (err) {
			if (!(err instanceof MissingPermission)) throw err;
			nicknameWarning = `Cannot set the bot's nickname to "${agentName}": the bot lacks the Change Nickname permission.`;
			log("warn", "nickname not set", { nickname: agentName, error: errorMessage(err) });
		}
		log("info", "discord ready", { user: connection.status().user });
	}

	/** DSC-04: the ephemeral refusal, logged as `command refused`. */
	async function refuse(e: CommandEvent, reason: AccessRefusal): Promise<void> {
		log("info", "command refused", { user: e.actor.userId, command: e.command, channel: e.where.channelId, parent: e.where.parentId ?? undefined, reason });
		await e.reply({ content: refusalMessage(config, reason, e.where), ephemeral: true });
	}

	async function onCommand(e: CommandEvent): Promise<void> {
		if (e.command === "ask") {
			const access = askAccess(config, e.where);
			if (!access.ok) return refuse(e, access.reason);
			return askChat.command(e);
		}
		// DSC-39: `/stop` in an ask thread, by its starter or an allowed member.
		const threadId = e.where.channelId;
		const access = stopAccess(config, e.actor, e.where.isThread ? askChat.ownerOf(threadId) : undefined);
		if (!access.ok) return refuse(e, access.reason);
		await e.reply({ content: await askChat.stop(threadId, `@${e.actor.username}`) });
	}

	async function onMessage(e: MessageEvent): Promise<void> {
		// DSC-08: bot authors, DMs and channel messages are not for us.
		if (e.actor.isBot || !e.where.guildId || !e.where.isThread) return;
		// Ask threads check their own access (DSC-06); other threads are not the bot's.
		await askChat.message(e);
	}

	const offReady = connection.onReady(onReady);
	const offEvent = connection.onEvent(event => {
		if (deps.signal.aborted) return;
		return event.type === "command" ? onCommand(event) : onMessage(event);
	});
	return {
		detach() {
			offReady();
			offEvent();
		},
		nicknameWarning: () => nicknameWarning,
	};
}
