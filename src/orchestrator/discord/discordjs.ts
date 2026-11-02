import {
	type APIChannel,
	type APIMessage,
	type APIInteractionGuildMember,
	ApplicationCommandOptionType,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	type CommandInteractionOption,
	DiscordAPIError,
	Events,
	GatewayIntentBits,
	type GuildMember,
	type InteractionReplyOptions,
	type Message,
	MessageFlags,
	type RateLimitData,
	RateLimitError,
	RESTEvents,
	Routes,
	type TextBasedChannel,
} from "discord.js";
import { errorMessage, log } from "../../shared/log";
import { createOutboundQueue } from "./queue";
import {
	type Actor,
	type DiscordConnection,
	type InAttachment,
	type InboundEvent,
	type InteractionResponder,
	MissingPermission,
	type MsgRef,
	type OutMessage,
	type Priority,
	type ReplyOptions,
	type Where,
} from "./surface";

/**
 * `DiscordConnection` over a discord.js `Client`. discord.js is imported only here and in `rest.ts` (the REST-only client
 * the admin API uses whether or not the engine runs). Writes go to Discord's REST API through the outbound queue
 * (DSC-32); discord.js is told to reject, not wait, when a queued route is rate-limited, so the queue owns the
 * retry-after. Interaction responses and reads are not queued.
 */

/** Discord answers an interaction within 3 s or fails it; slower handlers are deferred automatically. */
const AUTO_DEFER_MS = 2_500;

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function apiCode(err: unknown): number | undefined {
	return err instanceof DiscordAPIError && typeof err.code === "number" ? err.code : undefined;
}

/** Writes the queue performs: everything except reads under /channels and /guilds (interaction callbacks are excluded). */
function isQueuedRoute(data: Pick<RateLimitData, "route" | "method">): boolean {
	return data.method.toUpperCase() !== "GET" && (data.route.startsWith("/channels") || data.route.startsWith("/guilds"));
}

/** DSC-07: every bot message disables all mentions. */
const NO_MENTIONS = { parse: [] };

/** REST body and files of a message create or edit. */
export function restMessage(msg: OutMessage, extra: Record<string, unknown> = {}) {
	const files = msg.files?.map((file, index) => ({ key: `files[${index}]`, name: file.name, data: file.data }));
	return {
		body: {
			content: msg.content,
			allowed_mentions: NO_MENTIONS,
			...(files ? { attachments: files.map((file, index) => ({ id: index, filename: file.name })) } : {}),
			...extra,
		},
		...(files ? { files } : {}),
	};
}

/** Payload of an interaction reply edit (no flags). */
function editPayload(msg: OutMessage) {
	return {
		content: msg.content,
		allowedMentions: NO_MENTIONS,
		...(msg.files ? { files: msg.files.map(file => ({ attachment: Buffer.from(file.data), name: file.name })) } : {}),
	};
}

function replyPayload(msg: ReplyOptions): InteractionReplyOptions {
	return { ...editPayload(msg), ...(msg.ephemeral ? { flags: MessageFlags.Ephemeral } : {}) };
}

function isThreadType(type: ChannelType): boolean {
	return type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;
}

function actorOf(user: { id: string; username: string; bot: boolean }, member: GuildMember | APIInteractionGuildMember | null | undefined): Actor {
	const roleIds = !member ? [] : Array.isArray(member.roles) ? [...member.roles] : [...(member as GuildMember).roles.cache.keys()];
	return { userId: user.id, username: user.username, roleIds, isBot: user.bot };
}

function whereOf(guildId: string | null, channelId: string, channel: TextBasedChannel | null): Where {
	const isThread = !!channel?.isThread();
	return { guildId, channelId, parentId: isThread && channel?.isThread() ? channel.parentId : null, isThread };
}

function attachmentOf(a: { name: string; url: string; size: number; contentType: string | null }): InAttachment {
	return { name: a.name, url: a.url, size: a.size, ...(a.contentType ? { contentType: a.contentType } : {}) };
}

/**
 * Interaction responses with the 3 s rule handled here (DSC-08 keeps it out of engine code): if the handler has not
 * responded after `autoDeferMs`, the interaction is deferred as a public "thinking" reply, and later responses are
 * mapped onto the deferred one.
 */
function responder(i: ChatInputCommandInteraction, autoDeferMs: number) {
	let acked = false;
	let deferring: Promise<unknown> | undefined;
	const timer = setTimeout(() => {
		if (acked) return;
		acked = true;
		deferring = i.deferReply().catch(err => log("warn", "interaction auto-defer failed", { error: errorMessage(err) }));
	}, autoDeferMs);
	const take = async (): Promise<boolean> => {
		clearTimeout(timer);
		if (!deferring) {
			acked = true;
			return false;
		}
		await deferring;
		return true;
	};

	const base: InteractionResponder = {
		async reply(msg) {
			if (!(await take())) return void (await i.reply(replyPayload(msg)));
			if (msg.ephemeral) {
				await i.followUp(replyPayload(msg));
				await i.deleteReply().catch(() => {});
			} else {
				await i.editReply(editPayload(msg));
			}
		},
		async defer(opts) {
			if (await take()) return;
			await i.deferReply(opts?.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
		},
		async editReply(msg) {
			await take();
			await i.editReply(editPayload(msg));
		},
		async followUp(msg) {
			await take();
			await i.followUp(replyPayload(msg));
		},
	};
	return {
		base,
		get acked() {
			return acked;
		},
		done: () => clearTimeout(timer),
	};
}

/** Command options as name → value; attachment options are returned separately. */
function commandOptions(data: readonly CommandInteractionOption[]): { options: Record<string, string | number | boolean>; attachments: InAttachment[] } {
	const options: Record<string, string | number | boolean> = {};
	const attachments: InAttachment[] = [];
	for (const option of data) {
		if (option.type === ApplicationCommandOptionType.Attachment) {
			if (option.attachment) attachments.push(attachmentOf(option.attachment));
		} else if (option.value !== undefined) {
			options[option.name] = option.value;
		}
	}
	return { options, attachments };
}

export interface DiscordJsOptions {
	/** Default 2500 ms. */
	autoDeferMs?: number;
}

export function createDiscordJsConnection(opts: DiscordJsOptions = {}): DiscordConnection {
	const autoDeferMs = opts.autoDeferMs ?? AUTO_DEFER_MS;
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		allowedMentions: { parse: [] },
		rest: { rejectOnRateLimit: data => isQueuedRoute(data) },
	});
	const queue = createOutboundQueue({
		rateLimitOf: err => (err instanceof RateLimitError ? { retryAfterMs: err.retryAfter > 0 ? err.retryAfter : err.timeToReset, global: err.global } : undefined),
	});
	client.rest.on(RESTEvents.RateLimited, data => {
		if (data.global) queue.limited(null, data.retryAfter);
		else if (data.route.startsWith("/channels")) queue.limited(data.majorParameter, data.retryAfter);
	});
	const eventHandlers = new Set<(event: InboundEvent) => void | Promise<void>>();
	const readyHandlers = new Set<() => void | Promise<void>>();

	function write<T>(priority: Priority, bucket: string, run: () => Promise<T>, coalesce?: string): Promise<T> {
		return queue.push({ priority, bucket, coalesce, run }) as Promise<T>;
	}

	async function getChannel(id: string): Promise<APIChannel | null> {
		try {
			return (await client.rest.get(Routes.channel(id))) as APIChannel;
		} catch (err) {
			const code = apiCode(err);
			if (code === UNKNOWN_CHANNEL || code === MISSING_ACCESS) return null;
			throw err;
		}
	}

	async function getMessage(ref: MsgRef): Promise<APIMessage | null> {
		try {
			return (await client.rest.get(Routes.channelMessage(ref.channelId, ref.messageId))) as APIMessage;
		} catch (err) {
			const code = apiCode(err);
			if (code === UNKNOWN_MESSAGE || code === UNKNOWN_CHANNEL || code === MISSING_ACCESS) return null;
			throw err;
		}
	}

	async function fire(): Promise<void> {
		for (const handler of readyHandlers) {
			try {
				await handler();
			} catch (err) {
				log("error", "discord ready handler failed", { error: errorMessage(err) });
			}
		}
	}

	/** Runs every handler; an unhandled error is logged and, for an interaction, answered `Error: <message>` (DSC-08). */
	async function deliver(event: InboundEvent, r?: ReturnType<typeof responder>): Promise<void> {
		try {
			for (const handler of eventHandlers) {
				try {
					await handler(event);
				} catch (err) {
					log("error", "discord event handler failed", { event: event.type, error: errorMessage(err) });
					if (!r) continue;
					const answer = { content: `Error: ${errorMessage(err)}`, ephemeral: true };
					await (r.acked ? r.base.followUp(answer) : r.base.reply(answer)).catch(e => log("warn", "error reply failed", { error: errorMessage(e) }));
				}
			}
		} finally {
			r?.done();
		}
	}

	client.on(Events.InteractionCreate, async interaction => {
		if (!interaction.isChatInputCommand()) return;
		const command = interaction.commandName;
		if (command !== "ask" && command !== "stop") return;
		const r = responder(interaction, autoDeferMs);
		const { options, attachments } = commandOptions(interaction.options.data);
		const where = whereOf(interaction.guildId, interaction.channelId, interaction.channel);
		await deliver({ type: "command", command, options, attachments, actor: actorOf(interaction.user, interaction.member), where, ...r.base }, r);
	});

	client.on(Events.MessageCreate, async (message: Message) => {
		// DSC-08: bot authors and direct messages are ignored; messages outside threads go to the bot, which decides.
		if (message.author.bot || !message.inGuild()) return;
		await deliver({
			type: "message",
			ref: { channelId: message.channelId, messageId: message.id },
			content: message.content,
			attachments: [...message.attachments.values()].map(attachmentOf),
			actor: actorOf(message.author, message.member),
			where: whereOf(message.guildId, message.channelId, message.channel),
		});
	});

	// The first ready fires on ClientReady; later READYs (a reconnect with a new session) arrive as ShardReady.
	client.once(Events.ClientReady, () => void fire());
	client.on(Events.ShardReady, () => {
		if (client.isReady()) void fire();
	});
	client.on(Events.Error, err => log("error", "discord client error", { error: errorMessage(err) }));

	return {
		send(channelId, msg, priority = "high") {
			return write(priority, channelId, async () => {
				const sent = (await client.rest.post(Routes.channelMessages(channelId), restMessage(msg))) as APIMessage;
				return { channelId, messageId: sent.id };
			});
		},
		reply(to, msg, priority = "high") {
			return write(priority, to.channelId, async () => {
				const sent = (await client.rest.post(
					Routes.channelMessages(to.channelId),
					restMessage(msg, { message_reference: { message_id: to.messageId, fail_if_not_exists: false } }),
				)) as APIMessage;
				return { channelId: to.channelId, messageId: sent.id };
			});
		},
		async edit(ref, msg, priority) {
			await write(
				priority,
				ref.channelId,
				async () => {
					await client.rest.patch(Routes.channelMessage(ref.channelId, ref.messageId), restMessage(msg));
				},
				`edit:${ref.messageId}`,
			);
		},
		startThread(from, o) {
			return write("high", from.channelId, async () => {
				const thread = (await client.rest.post(Routes.threads(from.channelId, from.messageId), {
					body: { name: o.name, auto_archive_duration: o.autoArchiveMinutes },
				})) as APIChannel;
				return thread.id;
			});
		},
		react(ref, emoji) {
			return write("high", ref.channelId, async () => {
				await client.rest.put(Routes.channelMessageOwnReaction(ref.channelId, ref.messageId, encodeURIComponent(emoji)));
			});
		},
		unreact(ref, emoji) {
			return write("high", ref.channelId, async () => {
				await client.rest.delete(Routes.channelMessageOwnReaction(ref.channelId, ref.messageId, encodeURIComponent(emoji)));
			});
		},
		async fetchMessage(ref) {
			const message = await getMessage(ref);
			return message ? { content: message.content } : null;
		},
		async starterMessage(threadId) {
			const thread = await getChannel(threadId);
			if (!thread || !isThreadType(thread.type) || !("parent_id" in thread) || !thread.parent_id) return null;
			// A thread started from a message has that message's id.
			const ref = { channelId: thread.parent_id, messageId: threadId };
			const message = await getMessage(ref);
			return message ? { ...ref, content: message.content } : null;
		},
		setNickname(guildId, nickname) {
			return write("state", `guild:${guildId}`, async () => {
				try {
					await client.rest.patch(Routes.guildMember(guildId, "@me"), { body: { nick: nickname } });
				} catch (err) {
					if (apiCode(err) === MISSING_PERMISSIONS) throw new MissingPermission("ChangeNickname");
					throw err;
				}
			});
		},
		queueStats: () => queue.stats(),

		onEvent(handler) {
			eventHandlers.add(handler);
			return () => eventHandlers.delete(handler);
		},
		onReady(handler) {
			readyHandlers.add(handler);
			return () => readyHandlers.delete(handler);
		},
		async registerCommands(guildId, commands) {
			const guild = await client.guilds.fetch(guildId);
			await guild.commands.set(commands);
		},
		status() {
			if (!client.isReady()) return { ready: false };
			const ping = client.ws.ping;
			return { ready: true, user: client.user.tag, userId: client.user.id, ...(ping >= 0 ? { pingMs: ping } : {}) };
		},
		async login(token) {
			await client.login(token);
		},
		async destroy() {
			queue.close(new Error("Discord connection closed"));
			await client.destroy();
		},
	};
}
