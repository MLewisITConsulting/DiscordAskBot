import { describe, expect, test } from "bun:test";
import { askAccess, askThreadAllowed, memberAllowed, refusalMessage, stopAccess } from "../../src/orchestrator/discord/access";
import type { Actor, Where } from "../../src/orchestrator/discord/surface";
import { parseConfig } from "../../src/shared/config";

const config = parseConfig({ discord: { guildId: "g", allowedUserIds: ["admin"], allowedRoleIds: ["role-ops"], askChannelIds: ["ask-1", "ask-2"] } });

const member = (userId: string, roleIds: string[] = []): Actor => ({ userId, username: userId, roleIds, isBot: false });
const channel = (channelId: string): Where => ({ guildId: "g", channelId, parentId: null, isThread: false });
const thread = (channelId: string, parentId: string): Where => ({ guildId: "g", channelId, parentId, isThread: true });

describe("askAccess (DSC-03, DSC-04)", () => {
	test("anyone may /ask directly in an ask-only channel", () => {
		expect(askAccess(config, channel("ask-1"))).toEqual({ ok: true });
		expect(askAccess(config, channel("ask-2"))).toEqual({ ok: true });
	});

	test("/ask outside an ask-only channel is refused as elsewhere", () => {
		expect(askAccess(config, channel("general"))).toEqual({ ok: false, reason: "ask-elsewhere" });
		expect(askAccess(config, thread("thread-2", "general"))).toEqual({ ok: false, reason: "ask-elsewhere" });
	});

	test("/ask inside a thread of an ask-only channel is refused as a thread, not as a wrong channel", () => {
		expect(askAccess(config, thread("thread-1", "ask-1"))).toEqual({ ok: false, reason: "ask-in-thread" });
	});

	test("no ask-only channels configured: /ask is refused as unconfigured", () => {
		const none = parseConfig({ discord: { guildId: "g", allowedUserIds: ["admin"] } });
		expect(askAccess(none, channel("ask-1"))).toEqual({ ok: false, reason: "ask-unconfigured" });
	});
});

describe("stopAccess (DSC-39)", () => {
	test("in an ask thread: the thread starter and allowed members, by id or role", () => {
		expect(stopAccess(config, member("owner"), "owner")).toEqual({ ok: true });
		expect(stopAccess(config, member("admin"), "owner")).toEqual({ ok: true });
		expect(stopAccess(config, member("someone", ["role-ops"]), "owner")).toEqual({ ok: true });
	});

	test("in an ask thread, anyone else is refused as not-allowed", () => {
		expect(stopAccess(config, member("stranger"), "owner")).toEqual({ ok: false, reason: "not-allowed" });
		expect(stopAccess(config, { ...member("admin"), isBot: true }, "owner")).toEqual({ ok: false, reason: "not-allowed" });
	});

	test("anywhere else, everyone is refused as not-an-ask-thread, allowed members too", () => {
		for (const who of [member("stranger"), member("admin")]) expect(stopAccess(config, who, undefined)).toEqual({ ok: false, reason: "not-an-ask-thread" });
	});
});

describe("refusalMessage (DSC-04)", () => {
	test("ask-in-thread names the parent channel; ask-elsewhere lists the ask-only channels", () => {
		expect(refusalMessage(config, "ask-in-thread", thread("thread-1", "ask-1"))).toContain("<#ask-1>");
		expect(refusalMessage(config, "ask-elsewhere", channel("general"))).toBe("`/ask` only works in <#ask-1>, <#ask-2>.");
	});

	test("/stop outside an ask thread says where it works", () => {
		expect(refusalMessage(config, "not-an-ask-thread", channel("general"))).toBe("Use inside an ask thread");
		expect(refusalMessage(config, "not-allowed", thread("t", "ask-1"))).toStartWith("Not authorized");
	});
});

describe("members", () => {
	test("allowed members are decided by user id or role; a bot never is", () => {
		expect(memberAllowed(config, member("admin"))).toBe(true);
		expect(memberAllowed(config, member("someone", ["role-ops"]))).toBe(true);
		expect(memberAllowed(config, member("stranger", ["role-other"]))).toBe(false);
		expect(memberAllowed(config, { ...member("admin"), isBot: true })).toBe(false);
		expect(memberAllowed(config, null)).toBe(false);
	});

	test("the owner and allowed members may post in an ask thread; strangers may not (DSC-06)", () => {
		expect(askThreadAllowed(config, member("owner"), "owner")).toBe(true);
		expect(askThreadAllowed(config, member("admin"), "owner")).toBe(true);
		expect(askThreadAllowed(config, member("stranger"), "owner")).toBe(false);
	});
});
