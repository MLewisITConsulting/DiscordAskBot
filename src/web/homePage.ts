import type { AdminState, EnginePhase, HomeFacts } from "../shared/adminApi";
import type { VersionInfo } from "../shared/version";
import { type Cell, formatTime } from "./live";
import { esc, layout, messages, nav, ORCHESTRATOR_UNAVAILABLE, pageLink, SITE_PAGES, type SitePageId, table } from "./views";

const PHASE_BADGE: Record<EnginePhase, string> = {
	setup: "warn",
	locked: "warn",
	unconfigured: "warn",
	starting: "warn",
	running: "ok",
	stopping: "warn",
	error: "bad",
};

/** One-line description per page. `Record` makes a new `SitePageId` fail to compile without card text. */
const CARD_TEXT: Record<SitePageId, string> = {
	status: "Engine state, Discord and its write queue, limits, workers, runs and their setup time, active ask threads, usage and the latest loadout.",
	logs: "Live agent transcripts, and the agent and orchestrator log files to download.",
	settings: "Discord, ask-only channels, models, limits, secrets and the admin account.",
	models: "Sign in to model providers and see the available model ids.",
	omp: "omp setting overrides, the omp version and updates.",
	skills: "Upload and remove the skills and task agents /ask loads.",
	"status-json": "Machine-readable status and usage.",
	healthz: "Unauthenticated web health, with the orchestrator's phase and limits.",
};

export interface HomePageOptions {
	/** Undefined when the orchestrator is unavailable. */
	state?: AdminState;
	/** This web process's versions. */
	version: VersionInfo;
}

export function versionSection(version: VersionInfo, orchestratorVersion: string | undefined): string {
	const dep = (name: string) => version.dependencies[name] ?? "unknown";
	const rows: Cell[][] = [
		["AskBot (web)", version.askbot],
		["AskBot (orchestrator)", orchestratorVersion ?? ORCHESTRATOR_UNAVAILABLE],
		["Commit", version.commit],
		["Image built at", version.builtAt ? formatTime(version.builtAt) : "— (not set)"],
		["omp SDK", dep("@oh-my-pi/pi-coding-agent")],
		["discord.js", dep("discord.js")],
		["zod", dep("zod")],
		["Bun", version.runtime.bun],
		["OS / arch", `${version.runtime.os} / ${version.runtime.arch}`],
		["Running in a container", version.runtime.container ? "yes" : "no"],
		["Web started at", formatTime(version.startedAt)],
	];
	const mismatch =
		orchestratorVersion !== undefined && orchestratorVersion !== version.askbot
			? `<p class="warning">The web pod and the orchestrator run different AskBot versions.</p>`
			: "";
	return `<details open><summary><h2>Version</h2></summary>
${table([], rows, "")}
${mismatch}</details>`;
}

/** A copyable code sample: caption (trusted HTML), Copy button, `<pre><code>`. */
function codeBlock(caption: string, code: string): string {
	return `<figure class="code"><figcaption>${caption}</figcaption>
<button type="button" class="copy">Copy</button><pre><code>${esc(code)}</code></pre></figure>`;
}

/** Copies the sibling `<pre>`'s text; no HTML is ever written. */
const COPY_SCRIPT = `<script>
for (const button of document.querySelectorAll("button.copy")) {
	button.addEventListener("click", async () => {
		const pre = button.parentElement.querySelector("pre");
		try {
			await navigator.clipboard.writeText(pre.textContent);
			button.textContent = "Copied";
		} catch {
			button.textContent = "Copy failed";
		}
		setTimeout(() => { button.textContent = "Copy"; }, 1500);
	});
}
</script>`;

const HOME_STYLE = `<style>
figure.code { margin: .5rem 0 1rem; }
figure.code pre { overflow-x: auto; border: 1px solid var(--border); border-radius: 4px; padding: .5rem; }
ol.steps li { margin: .25rem 0; }
</style>`;

type ChecklistStep = keyof HomeFacts["checklist"];

/** Getting-started steps in order, each with where it is done (trusted HTML). */
const CHECKLIST: readonly { step: ChecklistStep; html: string }[] = [
	{ step: "setup", html: `Create the admin account on <a href="/setup">Setup</a> with the token from the orchestrator log.` },
	{ step: "botToken", html: `Enter the Discord bot token on <a href="/admin">Settings</a>.` },
	{ step: "guild", html: `Enter the Discord guild (server) id on <a href="/admin">Settings</a>.` },
	{ step: "allowedUsers", html: `Add at least one allowed user or role on <a href="/admin">Settings</a>.` },
	{ step: "askChannel", html: `Choose an ask-only channel, where anyone can use <code>/ask</code>, on <a href="/admin">Settings</a>.` },
	{
		step: "modelAccess",
		html: `Sign in to a model provider on <a href="/admin/models">Model accounts</a>, or add a provider API key on <a href="/admin">Settings</a>.`,
	},
];

function gettingStarted(checklist: HomeFacts["checklist"]): string {
	const steps = CHECKLIST.map(({ step, html }) => {
		const done = checklist[step];
		const mark = done ? '<span class="badge ok" title="done">✓</span>' : '<span class="badge warn" title="to do">to do</span>';
		return `<li data-step="${step}" class="${done ? "done" : "todo"}">${mark} ${html}</li>`;
	});
	return `<details open id="getting-started"><summary><h2>Getting started</h2></summary>
<ol class="steps">
${steps.join("\n")}
<li>Then check <a href="/status">Status</a> and try <code>/ask</code> in an ask-only channel.</li>
</ol></details>`;
}

/** Sample settings document (requirements §9); exported so tests check it against the real schema. Secrets are placeholders. */
export const SAMPLE_SETTINGS = {
	config: {
		discord: {
			guildId: "123456789012345678",
			allowedUserIds: ["234567890123456789"],
			allowedRoleIds: [],
			askChannelIds: ["345678901234567890"],
		},
		agent: { name: "AskBot" },
		models: { ask: "anthropic/claude-sonnet-4-5", thinking: "high" },
		limits: { maxChatSessions: 2, maxCostUsdPerTurn: 15, chatIdleMinutes: 30 },
		workers: { reattachGraceSeconds: 90 },
		logs: { maxGiB: 5 },
		omp: { autoUpdate: false },
	},
	secrets: { discordToken: "<bot token>", providerKeys: { openai: "<API key>" } },
};

/** Sample omp overrides (the omp page); exported so tests check it against the real schema. */
export const SAMPLE_OMP = {
	settings: { "compaction.enabled": true },
};

function sampleConfigs(): string {
	return `<details id="samples"><summary><h2>Sample configs</h2></summary>
${codeBlock(`Settings as a whole (requirements §9), as <a href="/admin">Settings</a> stores them; secrets are write-only there:`, JSON.stringify(SAMPLE_SETTINGS, null, 2))}
${codeBlock(`omp overrides, as on <a href="/admin/omp">omp</a>:`, JSON.stringify(SAMPLE_OMP, null, 2))}
</details>`;
}

export function homePage(opts: HomePageOptions): string {
	const { state } = opts;
	const cards = SITE_PAGES.map(page => `<article class="card"><h3>${pageLink(page)}</h3><p class="hint">${esc(CARD_TEXT[page.id])}</p></article>`);
	const engine = state
		? `<p>Engine <span class="badge ${PHASE_BADGE[state.phase] ?? "warn"}">${esc(state.phase)}</span>
<span class="hint">since ${esc(formatTime(state.since))}</span></p>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
<ul class="facts">
<li>Model accounts: <strong id="model-accounts">${state.home.modelAccounts ?? "—"}</strong></li>
</ul>`
		: messages(`The ${ORCHESTRATOR_UNAVAILABLE}: the engine state and settings can't be shown until it is back.`);
	return layout(
		"Home",
		`${nav("home")}
${HOME_STYLE}
<h1>AskBot</h1>
${engine}
<div class="cards">
${cards.join("\n")}
</div>
${state ? gettingStarted(state.home.checklist) : ""}
${versionSection(opts.version, state?.version)}
${sampleConfigs()}
${COPY_SCRIPT}`,
	);
}
