import { afterEach, expect, test } from "bun:test";
import { REST, Routes } from "discord.js";
import { restMessage } from "../../src/orchestrator/discord/discordjs";
import { type FakeDiscordRest, startFakeDiscordRest } from "../fakes/discordRest";

/** DSC-07 on the wire: what discord.js actually sends as `allowed_mentions` for the gateway adapter's `restMessage`. */

let fake: FakeDiscordRest | undefined;
afterEach(async () => {
	await fake?.stop();
	fake = undefined;
});

test("every bot message is sent with all mentions disabled (DSC-07)", async () => {
	fake = startFakeDiscordRest();
	const channel = fake.addChannel({ name: "ask" });
	const rest = new REST({ api: fake.api, retries: 0 }).setToken(fake.token);

	await rest.post(Routes.channelMessages(channel.id), restMessage({ content: "Hey @everyone, @here and <@123> <@&456>, look" }));

	expect(fake.messages.map(m => m.allowedMentions)).toEqual([{ parse: [] }]);
});
