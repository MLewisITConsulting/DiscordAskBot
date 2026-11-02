import { type Config, isAllowedMember, isAskChannel } from "../../shared/config";
import type { Actor, Where } from "./surface";

/** Authorization for allowed members (DSC-02). */
export function memberAllowed(config: Config, actor: Actor | null): boolean {
	if (!actor || actor.isBot) return false;
	return isAllowedMember(config, actor.userId, actor.roleIds);
}

/** Follow-ups, steering and `/stop` in an ask thread: the person who started it, or an allowed member (DSC-02, DSC-06). */
export function askThreadAllowed(config: Config, actor: Actor, ownerId: string): boolean {
	return actor.userId === ownerId || memberAllowed(config, actor);
}

/** DSC-04: `ask-*` for `/ask`, `not-an-ask-thread` and `not-allowed` for `/stop`. */
export type AccessRefusal = "ask-in-thread" | "ask-elsewhere" | "ask-unconfigured" | "not-an-ask-thread" | "not-allowed";
export type CommandAccess = { ok: true } | { ok: false; reason: AccessRefusal };

/**
 * DSC-03: `/ask` is open to everyone directly in an ask-only channel and refused everywhere else, for allowed members
 * too, because it starts a thread from the channel itself.
 */
export function askAccess(config: Config, where: Where): CommandAccess {
	if (!where.isThread && isAskChannel(config, where.channelId)) return { ok: true };
	if (config.discord.askChannelIds.length === 0) return { ok: false, reason: "ask-unconfigured" };
	return { ok: false, reason: where.isThread && isAskChannel(config, where.parentId) ? "ask-in-thread" : "ask-elsewhere" };
}

/** DSC-39: `/stop` in an ask thread (`ownerId` is its starter; undefined anywhere else) by its starter or an allowed member. */
export function stopAccess(config: Config, actor: Actor, ownerId: string | undefined): CommandAccess {
	if (ownerId === undefined) return { ok: false, reason: "not-an-ask-thread" };
	return askThreadAllowed(config, actor, ownerId) ? { ok: true } : { ok: false, reason: "not-allowed" };
}

/** The ephemeral reply that tells a refused user why (DSC-04). */
export function refusalMessage(config: Config, reason: AccessRefusal, where: Pick<Where, "parentId">): string {
	switch (reason) {
		case "ask-in-thread":
			return `\`/ask\` starts a new thread: run it in <#${where.parentId}>, not inside a thread. To follow up here, reply in this thread (only the person who started it can).`;
		case "ask-elsewhere":
			return `\`/ask\` only works in ${config.discord.askChannelIds.map(id => `<#${id}>`).join(", ")}.`;
		case "ask-unconfigured":
			return "No ask-only channel is set up on this server.";
		case "not-an-ask-thread":
			return "Use inside an ask thread";
		case "not-allowed":
			return "Not authorized: only the person who started this thread or an allowed member can stop it.";
	}
}
