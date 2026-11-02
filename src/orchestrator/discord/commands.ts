import {
	type APIApplicationCommandBasicOption,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";

/**
 * The guild's complete command list (DSC-01): exactly `/ask prompt [file file2 file3]` and `/stop`, replaced at every
 * ready event. The command names never change with `agent.name` (DSC-31).
 */
export function commandDefinitions(agentName: string): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
	const file = (name: string, description: string): APIApplicationCommandBasicOption => ({
		type: ApplicationCommandOptionType.Attachment,
		name,
		description,
		required: false,
	});
	const ask: RESTPostAPIChatInputApplicationCommandsJSONBody = {
		type: ApplicationCommandType.ChatInput,
		name: "ask",
		description: `Ask ${agentName} a question in a new thread`.slice(0, 100),
		options: [
			{ type: ApplicationCommandOptionType.String, name: "prompt", description: "Question or request", required: true },
			file("file", "A file for the agent. Pick it here: files added with the + button are not sent"),
			file("file2", "Another file"),
			file("file3", "Another file"),
		],
	};
	const stop: RESTPostAPIChatInputApplicationCommandsJSONBody = {
		type: ApplicationCommandType.ChatInput,
		name: "stop",
		description: "Stop the run in this ask thread",
	};
	return [ask, stop];
}
