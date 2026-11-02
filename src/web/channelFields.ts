import type { SettingsView } from "../shared/adminApi";
import { CANT_SEE_CHANNEL, type ChannelChoice, type ChannelListing, CHANNELS_UNCONFIGURED } from "../shared/adminChannels";
import { type AdminClient, AdminApiError } from "./adminClient";
import { esc } from "./views";

/**
 * The Settings page's ask-only channel field (WEB-20 to WEB-23): typed ids until the bot token and guild id are stored,
 * then a dropdown from the orchestrator's channel listing. When listing fails, the field shows the error with Retry
 * while a hidden input keeps its stored value, so the rest of the form still saves.
 */

/** Dropdowns with more entries than this get a filter box (WEB-20). */
const FILTER_ABOVE = 20;

/** Query parameter of `GET /admin` that reloads the channel list (WEB-23 Refresh and Retry). */
export const REFRESH_CHANNELS = "refreshChannels";

/** The listing for the settings in `view`: unconfigured without a stored token and guild; API errors read as listing errors. */
export async function loadChannelListing(admin: AdminClient, view: SettingsView, refresh: boolean): Promise<ChannelListing> {
	if (!view.config?.discord.guildId || !view.secrets.discordToken) return { state: "unconfigured", message: CHANNELS_UNCONFIGURED };
	try {
		return await admin.call<ChannelListing>("GET", `/channels${refresh ? "?refresh=1" : ""}`);
	} catch (err) {
		if (!(err instanceof AdminApiError)) throw err;
		return { state: "error", error: `The Discord channels could not be listed: ${err.message}` };
	}
}

/** Label HTML (with its hover help) and the `aria-describedby` attribute of a field, as the settings form builds them. */
export interface FieldLabel {
	label: string;
	describedBy: string;
}

type Listed = Extract<ChannelListing, { state: "ok" }>;

/** What is wrong with a channel for the bot (WEB-21). */
function notes(c: ChannelChoice): string[] {
	return !c.viewable ? [CANT_SEE_CHANNEL] : c.missing.length ? [`missing ${c.missing.join(", ")}`] : [];
}

function optionText(c: ChannelChoice): string {
	const problems = notes(c);
	return problems.length ? `#${c.name} — ${problems.join("; ")}` : `#${c.name}`;
}

/** The warning under a configured channel; one that has disappeared reads "unknown channel <id>" (WEB-24). */
function currentWarning(c: ChannelChoice | undefined, id: string): string {
	if (!c) return `<p class="warning">unknown channel ${esc(id)}: it no longer exists or is not a text channel; remove it.</p>`;
	if (!c.viewable) return `<p class="warning">#${esc(c.name)}: ${esc(CANT_SEE_CHANNEL)}.</p>`;
	if (c.missing.length) return `<p class="warning">The bot lacks ${esc(c.missing.join(", "))} in #${esc(c.name)}.</p>`;
	return "";
}

/** An `<option>`; one the bot can't view is disabled (WEB-21). */
function option(c: ChannelChoice): string {
	return `<option value="${esc(c.id)}"${c.viewable ? "" : " disabled data-blocked"}>${esc(optionText(c))}</option>`;
}

/** The text channels `offered` keeps, uncategorized first, then grouped under their categories in Discord's order (WEB-20). */
function channelOptions(listing: Listed, offered: (c: ChannelChoice) => boolean): string {
	const shown = listing.channels.filter(offered);
	const html = (list: ChannelChoice[]) => list.map(option).join("");
	const groups = listing.categories.map(cat => {
		const inside = shown.filter(c => c.categoryId === cat.id);
		return inside.length ? `<optgroup label="${esc(cat.name)}">${html(inside)}</optgroup>` : "";
	});
	return html(shown.filter(c => c.categoryId === null)) + groups.join("");
}

function select(name: string, label: FieldLabel, options: string, count: number): string {
	const id = `select-${name}`;
	const filter = count > FILTER_ABOVE ? ` <input type="search" placeholder="Filter" aria-label="Filter the list" data-filter-for="${esc(id)}">` : "";
	return `<label><span>${label.label}</span> <select id="${esc(id)}" name="${esc(name)}"${label.describedBy}>${options}</select>${filter}</label>`;
}

/**
 * The ask-only channel field of the settings form, from its current text in `config` (a comma list). The configured
 * channels are listed with Remove boxes; the Add dropdown never offers a channel already in the list (WEB-22). `typed`
 * is the plain input used before the bot token and guild id are stored (WEB-23).
 */
export function channelFieldHtml(name: string, config: Record<string, string>, listing: ChannelListing, label: FieldLabel, typed: string): string {
	const value = config[name] ?? "";
	if (listing.state === "unconfigured") return `${typed}<p class="hint">${esc(listing.message)}</p>`;
	if (listing.state === "error") {
		const invite = listing.inviteLink ? ` <a href="${esc(listing.inviteLink)}">Invite the bot</a>` : "";
		return `<div class="channel-field"><label><span>${label.label}</span> <input type="hidden" name="${esc(name)}" value="${esc(value)}">
<span class="error" role="alert">${esc(listing.error)}${invite} <button type="submit" form="channels-refresh">Retry</button></span></label></div>`;
	}

	const byId = new Map(listing.channels.map(c => [c.id, c]));
	const asks = value.split(/[\s,]+/).filter(Boolean);
	const rows = asks.map(id => {
		const c = byId.get(id);
		return `<li><input type="hidden" name="${esc(name)}" value="${esc(id)}" data-ask-channel>${esc(c ? optionText(c) : `unknown channel ${id}`)}
<label style="display:inline"><input type="checkbox" name="${esc(name)}.remove" value="${esc(id)}"> Remove</label>${currentWarning(c, id)}</li>`;
	});
	const add = select(
		`${name}.add`,
		{ label: "Add ask-only channel", describedBy: label.describedBy },
		`<option value="">Choose a channel to add</option>${channelOptions(listing, c => !asks.includes(c.id))}`,
		listing.channels.length,
	);
	const refresh = ` <button type="submit" form="channels-refresh">Refresh channel list</button>`;
	return `<div class="channel-field"><span>${label.label}</span>${rows.length ? `<ul>${rows.join("\n")}</ul>` : `<p class="hint">None yet.</p>`}${add}${refresh}</div>`;
}

/** Outside the settings form: the GET form behind Refresh and Retry, and the script that filters long lists (WEB-20). */
export const CHANNEL_EXTRAS = `<form id="channels-refresh" method="get" action="/admin"><input type="hidden" name="${REFRESH_CHANNELS}" value="1"></form>
<script>
(function () {
	document.querySelectorAll("input[data-filter-for]").forEach(function (box) {
		var select = document.getElementById(box.getAttribute("data-filter-for"));
		box.addEventListener("input", function () {
			var q = box.value.trim().toLowerCase();
			Array.prototype.forEach.call(select.options, function (option) {
				option.hidden = !!q && !option.selected && option.textContent.toLowerCase().indexOf(q) < 0;
			});
		});
	});
})();
</script>`;
