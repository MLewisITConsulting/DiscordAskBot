import type { StatusReport, UsageGroup, UsageWindow } from "../shared/adminApi";
import type { Loadout } from "../shared/agent";
import { type Cell, formatCount, formatDuration, formatTime, formatUsd, type LiveContext, liveView, loadoutSummary } from "./live";
import { esc, layout, nav, table } from "./views";

export const USAGE_WINDOWS: readonly UsageWindow[] = ["24h", "7d", "30d", "all"];
export const WINDOW_LABELS: Record<UsageWindow, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", all: "All time" };
export const DEFAULT_WINDOW: UsageWindow = "7d";

type Usage = StatusReport["usage"];

const USAGE_HEADERS = ["Runs", "Cost", "Tokens in", "Tokens out", "Cache read", "Cache write"];
const GROUP_HEADERS = ["Runs", "Cost", "Tokens in", "Tokens out"];

function totalsCells(totals: Usage["totals"]): Cell[] {
	return [
		formatCount(totals.runs),
		formatUsd(totals.costUsd),
		formatCount(totals.tokensIn),
		formatCount(totals.tokensOut),
		formatCount(totals.cacheRead),
		formatCount(totals.cacheWrite),
	];
}

function dailyChart(daily: Usage["daily"]): string {
	const max = Math.max(0, ...daily.map(d => d.costUsd));
	const bars = daily.map(d => {
		const pct = max > 0 ? (d.costUsd / max) * 100 : 0;
		return `<div class="day" title="${esc(`${d.day}: ${formatUsd(d.costUsd)}`)}"><span>${esc(d.costUsd > 0 ? formatUsd(d.costUsd) : "")}</span>
<div class="track"><div class="bar" style="height:${pct.toFixed(1)}%"></div></div><span>${esc(d.day.slice(5))}</span></div>`;
	});
	return `<div class="chart" role="img" aria-label="Daily cost for the last ${daily.length} days">${bars.join("\n")}</div>`;
}

function groupRows(groups: UsageGroup[], label: (id: string) => Cell): Cell[][] {
	return groups.map(group => [label(group.id), formatCount(group.runs), formatUsd(group.costUsd), formatCount(group.tokensIn), formatCount(group.tokensOut)]);
}

function usageSection(usage: Usage, ctx: LiveContext): string {
	const windows = USAGE_WINDOWS.map(window =>
		window === usage.window
			? `<strong aria-current="page">${esc(WINDOW_LABELS[window])}</strong>`
			: `<a href="/status?window=${window}">${esc(WINDOW_LABELS[window])}</a>`,
	);
	const channel = (id: string): Cell => (ctx.guildId ? [`#${id}`, `https://discord.com/channels/${encodeURIComponent(ctx.guildId)}/${encodeURIComponent(id)}`] : `#${id}`);
	const { outcomes, setup } = usage;
	return `<section id="usage"><h2>Usage</h2>
<p>Window: ${windows.join(" · ")}${usage.since ? ` <span class="hint">(since ${esc(formatTime(usage.since))})</span>` : ""}</p>
<h3>Totals</h3>
${table(USAGE_HEADERS, [totalsCells(usage.totals)], "")}
<h3>By ask channel</h3>
${table(["Channel", ...GROUP_HEADERS], groupRows(usage.byChannel, channel), "No runs in this window.")}
<h3>By Discord user</h3>
${table(["User", ...GROUP_HEADERS], groupRows(usage.byUser, id => id), "No runs in this window.")}
<h3>Run outcomes</h3>
${table(
	["Finished", "Failed", "Stopped", "Stopped by a limit", "Avg duration"],
	[
		[
			formatCount(outcomes.finished),
			formatCount(outcomes.failed),
			formatCount(outcomes.stopped),
			formatCount(outcomes.limit),
			outcomes.avgDurationMs === null ? "—" : formatDuration(outcomes.avgDurationMs),
		],
	],
	"",
)}
<h3>Daily cost (last ${usage.daily.length} days)</h3>
${dailyChart(usage.daily)}
<h3>Setup time</h3>
<p class="hint">From a worker claiming a run to its agent starting: worker start and the downloads of skills, session and scratch inputs.</p>
${table(
	["Runs", "Average", "Slowest"],
	setup ? [[formatCount(setup.runs), formatDuration(setup.avgMs), formatDuration(setup.maxMs)]] : [],
	"No runs started in this window.",
)}
</section>`;
}

function loadoutSection(loadout: Loadout | undefined): string {
	const rows: Cell[][] = loadout
		? [
				["Captured", formatTime(loadout.capturedAt)],
				["Tools", loadout.tools.join(", ") || "—"],
				["Skills", loadout.skills.map(skill => skill.name).join(", ") || "—"],
				["Agents", loadout.agents.map(agent => agent.name).join(", ") || "—"],
			]
		: [];
	return `<section id="loadout"><h2>Latest loadout</h2>
${table([], rows, "No run has reported a loadout yet.")}
</section>`;
}

/** Replaces the rows of a `tbody` with text-only cells (links for `[text, href]`). */
const FILL_JS = `function fill(id, rows, empty) {
	const body = document.getElementById(id);
	const span = body.closest("table").tHead?.rows[0]?.cells.length || 1;
	body.replaceChildren(...(rows.length ? rows : [[empty]]).map(cells => {
		const tr = document.createElement("tr");
		for (const cell of cells) {
			const td = tr.insertCell();
			if (Array.isArray(cell)) {
				const a = document.createElement("a");
				a.href = cell[1];
				a.textContent = cell[0];
				td.append(a);
			} else td.textContent = cell;
		}
		if (!rows.length) tr.cells[0].colSpan = span;
		return tr;
	}));
}`;

/** Polls `/status.json` and re-renders the live sections with the same `liveView` the server uses. */
const STATUS_PAGE_SCRIPT = `<script>
${[formatUsd, formatCount, formatDuration, formatTime, loadoutSummary, liveView].map(fn => fn.toString()).join("\n")}
${FILL_JS}
const root = document.getElementById("status-root");
setInterval(async () => {
	try {
		const res = await fetch("/status.json" + location.search, { headers: { accept: "application/json" } });
		if (!res.ok) return;
		const data = await res.json();
		const view = liveView(data, { guildId: root.dataset.guild || undefined, now: Date.now() });
		fill("state-rows", view.state, "");
		fill("limit-rows", view.limits, "Limits are shown once the settings are saved and unlocked.");
		fill("worker-rows", view.workers, "No workers connected.");
		fill("warning-rows", view.warnings, "No warnings.");
		fill("pending-rows", view.pending, "No pending runs.");
		fill("run-rows", view.running, "No runs in progress.");
		fill("thread-rows", view.threads, "No active ask threads.");
	} catch {}
}, 5000);
</script>`;

export interface StatusPageOptions {
	report: StatusReport;
	context: LiveContext;
}

export function statusPage(opts: StatusPageOptions): string {
	const { report } = opts;
	const view = liveView(report, opts.context);
	return layout(
		"Status",
		`${nav("status")}
<main id="status-root" data-guild="${esc(opts.context.guildId ?? "")}">
<h1>Status</h1>
<section id="current" class="status" aria-live="polite"><h2>Current state</h2>
${table([], view.state, "", "state-rows")}
</section>
<section id="limits"><h2>Concurrency limits</h2>
${table([], view.limits, "Limits are shown once the settings are saved and unlocked.", "limit-rows")}
${table(["Warnings"], view.warnings, "No warnings.", "warning-rows")}
</section>
<section id="workers"><h2>Workers</h2>
${table(["Worker", "Address", "Run", "Phase", "omp", "Connected for"], view.workers, "No workers connected.", "worker-rows")}
</section>
<section id="runs"><h2>Runs</h2>
<h3>Pending</h3>
${table(["Thread", "Waiting for"], view.pending, "No pending runs.", "pending-rows")}
<h3>In progress</h3>
${table(["Thread", "Worker", "State", "Elapsed", "Setup", "Last tool", "Cost", "Tokens", "Loadout"], view.running, "No runs in progress.", "run-rows")}
</section>
<section id="threads"><h2>Active ask threads</h2>
${table(["Thread", "Channel", "Started by"], view.threads, "No active ask threads.", "thread-rows")}
</section>
${usageSection(report.usage, opts.context)}
${loadoutSection(report.loadout)}
</main>
${STATUS_PAGE_SCRIPT}`,
	);
}
