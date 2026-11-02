import type { SecretsView, SettingsSaveRequest, SettingsView } from "../shared/adminApi";
import { type Config, parseConfig } from "../shared/config";

export type FieldKind = "text" | "number" | "list" | "boolean";

export interface FieldDef {
	/** Dotted path into `Config`; also the form field name. */
	name: string;
	label: string;
	kind: FieldKind;
	/** Hover help next to the label; the schema default is appended by the view. */
	help: string;
	/** A sample value shown in the hover help. */
	example: string;
	/** Default shown in the hover help when the schema has no literal one (derived values). */
	defaultText?: string;
}

const MODEL_HELP =
	"A model id from omp's model list; its provider needs a sign-in (Model accounts) or an API key under Secrets. Blank uses omp's default model.";

const CHANNEL_ID_HELP =
	"Once the bot token and guild ID are saved, choose it from the list, which shows what the bot is missing in each channel. Before that, enter its ID: in Discord, turn on Developer Mode (User Settings → Advanced), then right-click the channel → Copy Channel ID.";

/** Every scalar/list field of `Config` (requirements §9), in display order. Sections come from the first path segment. */
export const CONFIG_FIELDS: FieldDef[] = [
	{
		name: "discord.guildId",
		label: "Guild ID",
		kind: "text",
		example: "123456789012345678",
		help: "ID of the Discord server (guild) AskBot works in. /ask and /stop are registered there, and every ask-only channel must be in it. Turn on Developer Mode (User Settings → Advanced), then right-click the server icon → Copy Server ID.",
	},
	{
		name: "discord.allowedUserIds",
		label: "Allowed user IDs",
		kind: "list",
		example: "234567890123456789, 345678901234567890",
		help: "Discord users who may follow up, steer and /stop in every ask thread, and who are exempt from the one-live-run limit. Right-click a user → Copy User ID. Separate several with commas or spaces. At least one user or role is required.",
	},
	{
		name: "discord.allowedRoleIds",
		label: "Allowed role IDs",
		kind: "list",
		example: "456789012345678901",
		help: "Members of these roles count as allowed members, like the allowed users. Server Settings → Roles → right-click a role → Copy Role ID. Separate several with commas or spaces.",
	},
	{
		name: "discord.askChannelIds",
		label: "Ask-only channels",
		kind: "list",
		example: "789012345678901234",
		help: `Channels where anyone may run /ask. The engine starts once at least one is chosen; on a fresh install, save the bot token and guild ID first, then choose them here. Separate several with commas or spaces. ${CHANNEL_ID_HELP}`,
	},
	{
		name: "agent.name",
		label: "Agent name",
		kind: "text",
		example: "Helper",
		help: "The bot's nickname in the guild and the name it uses in Discord messages and agent prompts, 1–32 characters.",
	},
	{
		name: "models.ask",
		label: "Ask model",
		kind: "text",
		example: "anthropic/claude-sonnet-4-5",
		help: `Model for every /ask turn. ${MODEL_HELP}`,
	},
	{
		name: "models.thinking",
		label: "Thinking level",
		kind: "text",
		example: "medium",
		help: "How much the model reasons before acting: auto, inherit, off, minimal, low, medium, high, xhigh or max. Higher is slower and costs more; models without reasoning ignore it.",
	},
	{
		name: "limits.maxChatSessions",
		label: "Max chat sessions",
		kind: "number",
		example: "4",
		help: "How many /ask runs can be active at the same time; a new /ask is refused while this many are. To use more workers, raise it up to the worker capacity.",
	},
	{
		name: "limits.maxCostUsdPerTurn",
		label: "Max cost per turn (USD)",
		kind: "number",
		example: "7.50",
		help: "Spending cap for one /ask turn including its task subagents, computed from the model's token prices. The turn is stopped when it reaches the cap; another message continues it.",
	},
	{
		name: "limits.chatIdleMinutes",
		label: "Chat idle minutes",
		kind: "number",
		example: "60",
		help: "After an ask thread has been quiet this long, its scratch folder (attachments and produced files) is deleted. The conversation is kept.",
	},
	{
		name: "workers.maxConcurrentRuns",
		label: "Max concurrent runs",
		kind: "number",
		example: "8",
		defaultText: "worker capacity",
		help: "How many agent runs may be dispatched to workers at once. Never rejected on save; the status page warns when it exceeds the worker capacity. Blank uses the worker capacity.",
	},
	{
		name: "workers.reattachGraceSeconds",
		label: "Re-attach grace (seconds)",
		kind: "number",
		example: "120",
		help: "How long a run's worker may stay disconnected (for example during an orchestrator restart) before the run is treated as lost.",
	},
	{
		name: "logs.maxGiB",
		label: "Rolling log size (GiB)",
		kind: "number",
		example: "2",
		help: "Total disk space for the orchestrator's rolling logs (agent transcripts and its own log); the oldest files are deleted when it is exceeded. ASKBOT_AGENT_LOG_MAX_BYTES overrides it.",
	},
	{
		name: "omp.autoUpdate",
		label: "Install omp updates automatically",
		kind: "boolean",
		example: "true",
		help: "When on, a newer omp for workers is installed as soon as the npm check finds it, without Approve update on the omp page. A version whose install or first run failed is not retried automatically; approve it on the omp page. Only in the container image.",
	},
];

export const SECTION_LABELS: Record<string, string> = {
	discord: "Discord",
	agent: "Agent",
	models: "Models",
	limits: "Limits",
	workers: "Workers",
	logs: "Logs",
	omp: "omp",
};

export const SECRET_FIELDS = {
	discordToken: "secrets.discordToken",
} as const;

export interface ProviderRow {
	name: string;
	/** A key is stored for this provider. */
	set: boolean;
}

/** Everything the settings form renders. Holds no secret values, only whether each one is set. */
export interface SettingsFormState {
	/** Keyed by `CONFIG_FIELDS[].name`. */
	config: Record<string, string>;
	providers: ProviderRow[];
	discordTokenSet: boolean;
}

/** Config defaults, read from the schema by parsing a minimal valid config. */
const DEFAULT_CONFIG: Config = parseConfig({ discord: { guildId: "-", allowedUserIds: ["-"] } });
/** Fields whose placeholder value in `DEFAULT_CONFIG` must not be shown as a default. */
const NO_DEFAULT_FIELDS = ["discord.guildId", "discord.allowedUserIds"];

/** Schema default of a config field for its hover help; "" when it has none. */
export function configDefault(def: FieldDef): string {
	if (def.defaultText !== undefined) return def.defaultText;
	return NO_DEFAULT_FIELDS.includes(def.name) ? "" : display(readPath(DEFAULT_CONFIG, def.name));
}

/** String value of a form field; files and missing fields read as "". */
export function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === "string" ? value : "";
}

function readPath(obj: unknown, path: string): unknown {
	let current = obj;
	for (const key of path.split(".")) {
		if (current === null || typeof current !== "object" || !(key in current)) return undefined;
		current = Reflect.get(current, key);
	}
	return current;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const keys = path.split(".");
	let current = obj;
	for (const key of keys.slice(0, -1)) {
		const next = current[key];
		if (next !== null && typeof next === "object") {
			current = next as Record<string, unknown>; // only objects created here are stored under config keys
		} else {
			const created: Record<string, unknown> = {};
			current[key] = created;
			current = created;
		}
	}
	current[keys.at(-1)!] = value;
}

function display(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}

/**
 * Blank → undefined (schema default applies); unparsable text is kept so validation reports it with its path.
 * Booleans are checkboxes: checked sends "true", unchecked sends nothing.
 */
function parseField(kind: FieldKind, raw: string): unknown {
	const text = raw.trim();
	if (kind === "list") return text ? text.split(/[\s,]+/).filter(Boolean) : [];
	if (!text) return undefined;
	if (kind === "number") {
		const number = Number(text);
		return Number.isNaN(number) ? text : number;
	}
	if (kind === "boolean") return text === "true" ? true : text === "false" ? false : text;
	return text;
}

/** Sorted row indices present in the form for fields named `<prefix>.<index>.<field>`. */
export function rowIndices(form: FormData, prefix: string): number[] {
	const pattern = new RegExp(`^${prefix.replaceAll(".", "\\.")}\\.(\\d+)\\.`);
	const indices = new Set<number>();
	for (const key of form.keys()) {
		const match = pattern.exec(key);
		if (match) indices.add(Number(match[1]));
	}
	return [...indices].sort((a, b) => a - b);
}

/** Submitted provider rows that have a name, with whether each is marked for removal. */
function providerRows(form: FormData): { name: string; key: string; remove: boolean }[] {
	const rows: { name: string; key: string; remove: boolean }[] = [];
	for (const i of rowIndices(form, "provider")) {
		const name = field(form, `provider.${i}.name`).trim();
		if (name) rows.push({ name, key: field(form, `provider.${i}.key`).trim(), remove: form.has(`provider.${i}.remove`) });
	}
	return rows;
}

/** Form name of the ask-only channel field (WEB-20); its dropdown control adds `.add` (a dropdown) and `.remove` (checkboxes). */
export const ASK_CHANNELS_FIELD = "discord.askChannelIds";

/**
 * The submitted text of a config field. Ask-only channels come as one typed list, or as one hidden input per channel
 * with Remove checkboxes and an Add dropdown (WEB-20); they are merged into one list.
 */
function submitted(form: FormData, name: string): string {
	if (name !== ASK_CHANNELS_FIELD) return field(form, name);
	const removed = new Set(form.getAll(`${name}.remove`));
	const ids = form
		.getAll(name)
		.flatMap(value => (typeof value === "string" ? value.split(/[\s,]+/) : []))
		.filter(id => id && !removed.has(id));
	const added = field(form, `${name}.add`).trim();
	if (added && !ids.includes(added)) ids.push(added);
	return ids.join(", ");
}

/**
 * Builds the admin API save request from the settings form; the orchestrator validates it as a whole (requirements §9).
 * Blank optional fields are omitted so schema defaults apply. Blank secret inputs are omitted, which keeps the stored
 * value; a provider row marked for removal is sent with an empty key, which deletes it.
 */
export function saveRequestFromForm(form: FormData): SettingsSaveRequest {
	const config: Record<string, unknown> = {};
	for (const def of CONFIG_FIELDS) {
		const value = parseField(def.kind, submitted(form, def.name));
		if (value !== undefined) setPath(config, def.name, value);
	}
	for (const section of Object.keys(SECTION_LABELS)) config[section] ??= {};

	const secrets: SettingsSaveRequest["secrets"] = {};
	const discordToken = field(form, SECRET_FIELDS.discordToken).trim();
	if (discordToken) secrets.discordToken = discordToken;
	const providerKeys: Record<string, string> = {};
	for (const row of providerRows(form)) {
		if (row.remove) providerKeys[row.name] = "";
		else if (row.key) providerKeys[row.name] = row.key;
	}
	if (Object.keys(providerKeys).length > 0) secrets.providerKeys = providerKeys;
	return { config, secrets };
}

/** Form state for the stored settings, or schema defaults when nothing was saved yet. */
export function formStateFromView(view: SettingsView): SettingsFormState {
	const config: Record<string, string> = {};
	for (const def of CONFIG_FIELDS) {
		config[def.name] = view.config || !NO_DEFAULT_FIELDS.includes(def.name) ? display(readPath(view.config ?? DEFAULT_CONFIG, def.name)) : "";
	}
	return {
		config,
		providers: view.secrets.providerKeys.map(name => ({ name, set: true })),
		discordTokenSet: view.secrets.discordToken,
	};
}

/** Form state echoing a rejected submission. Secret values are dropped; set/not set reflects what is stored. */
export function formStateFromSubmission(form: FormData, secrets: SecretsView): SettingsFormState {
	const config: Record<string, string> = {};
	for (const def of CONFIG_FIELDS) config[def.name] = submitted(form, def.name);
	return {
		config,
		providers: providerRows(form)
			.filter(row => !row.remove)
			.map(row => ({ name: row.name, set: secrets.providerKeys.includes(row.name) })),
		discordTokenSet: secrets.discordToken,
	};
}

/** What a settings save reports on the Settings page (ENG-02). */
export function settingsSavedText(result: { phase: string; error?: string }): string {
	return `Settings saved. Engine is ${result.phase}${result.error ? `: ${result.error.replace(/\.$/, "")}` : ""}.`;
}

export const MIN_PASSWORD_CHARS = 12;
export const MAX_USERNAME_CHARS = 64;

/** Returns an error message for unacceptable admin credentials (WEB-02), or undefined. */
export function credentialsError(username: string, password: string, confirm: string): string | undefined {
	if (username.length < 1 || username.length > MAX_USERNAME_CHARS) return `Username must be 1-${MAX_USERNAME_CHARS} characters.`;
	if (password.length < MIN_PASSWORD_CHARS) return `Password must be at least ${MIN_PASSWORD_CHARS} characters.`;
	if (password !== confirm) return "Passwords do not match.";
	return undefined;
}
