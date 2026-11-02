import type { OmpSettingInfo, OmpUpdateView, OmpView, PinnedSetting } from "../shared/adminOmp";
import { AUTO_UPDATE_BY, installedByText } from "../shared/adminOmp";
import { AdminApiError } from "./adminClient";
import { field } from "./forms";
import { html, json, type PageContext, type PageRoutes, redirect } from "./http";
import { formatTime } from "./live";
import { type OmpFormState, ompFormFromSubmission, ompFormFromView, ompSaveRequestFromForm, settingText } from "./ompForms";
import type { Flash } from "./sessions";
import { esc, layout, messages, nav } from "./views";

/** `/admin/omp`: omp setting overrides with a searchable reference (AGT-20, AGT-23), and the update panel (WEB-33). */

export const OMP_SAVED = "Saved. New agent runs use these settings; runs already in progress keep the configuration they started with.";

function setBadge(set: boolean): string {
	return `<span class="hint">${set ? "set" : "not set"}</span>`;
}

function options(values: readonly string[], selected: string): string {
	const all = values.includes(selected) || !selected ? values : [selected, ...values];
	return all.map(value => `<option${value === selected ? " selected" : ""}>${esc(value)}</option>`).join("");
}

/** Value control for an override: write-only for credentials, a select for enums/booleans, JSON textarea for arrays/records. */
function valueInput(name: string, info: OmpSettingInfo | undefined, value: string, credentialSet: boolean): string {
	if (info?.credential) {
		const input =
			info.type === "string"
				? `<input type="password" name="${name}" autocomplete="off" placeholder="blank keeps current">`
				: `<textarea name="${name}" autocomplete="off" placeholder="JSON; blank keeps current"></textarea>`;
		return `${input} ${setBadge(credentialSet)}`;
	}
	if (info?.type === "enum") return `<select name="${name}">${options(info.enumValues ?? [], value)}</select>`;
	if (info?.type === "boolean") return `<select name="${name}">${options(["true", "false"], value)}</select>`;
	if (info?.type === "array" || info?.type === "record") return `<textarea name="${name}">${esc(value)}</textarea>`;
	return `<input type="text" name="${name}" value="${esc(value)}">`;
}

function describe(info: OmpSettingInfo | undefined): string {
	if (!info) return "";
	const text = [info.label, info.description].filter(Boolean).join(" — ");
	return text ? `<div class="hint">${esc(text)}</div>` : "";
}

function settingsSection(form: OmpFormState, byId: Map<string, OmpSettingInfo>, reference: OmpSettingInfo[]): string {
	const rows = form.settings.map((row, i) => {
		const info = byId.get(row.id);
		return `<tr>
<td><input type="text" name="setting.${i}.id" value="${esc(row.id)}" readonly>${describe(info)}</td>
<td>${esc(info?.type ?? "?")}</td>
<td><code>${esc(info ? settingText(info, info.default) : "")}</code></td>
<td>${valueInput(`setting.${i}.value`, info, row.value, row.credentialSet)}</td>
<td><input type="checkbox" name="setting.${i}.remove" aria-label="Remove ${esc(row.id)}"></td>
</tr>`;
	});
	const newInfo = byId.get(form.newSetting.id);
	rows.push(`<tr>
<td><input type="text" name="setting.new.id" list="omp-setting-ids" placeholder="add setting id" value="${esc(form.newSetting.id)}"></td>
<td colspan="2" class="hint">Booleans true/false; arrays and records as JSON.</td>
<td><textarea name="setting.new.value" rows="2" placeholder="value">${esc(newInfo?.credential ? "" : form.newSetting.value)}</textarea></td>
<td></td>
</tr>`);
	const ids = reference.filter(info => !info.locked).map(info => `<option value="${esc(info.id)}">`);
	return `<h2>Setting overrides</h2>
<table><thead><tr><th>Setting</th><th>Type</th><th>Default</th><th>Value</th><th>Remove</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table>
<datalist id="omp-setting-ids">${ids.join("")}</datalist>`;
}

function pinnedSection(pinned: PinnedSetting[]): string {
	const rows = pinned.map(
		pin => `<tr><td><code>${esc(pin.id)}</code> <span class="badge">PINNED</span></td><td><code>${esc(JSON.stringify(pin.value))}</code></td><td>${esc(pin.reason)}</td></tr>`,
	);
	return `<h2>Pinned by AskBot</h2>
<p class="hint">Applied last on every run; these cannot be overridden.</p>
<table><thead><tr><th>Setting</th><th>Value</th><th>Why</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table>`;
}

function referenceSection(reference: OmpSettingInfo[]): string {
	const rows = reference.map(
		info => `<tr><td><code>${esc(info.id)}</code>${info.locked ? ` <span class="badge">PINNED</span><div class="hint">${esc(info.locked)}</div>` : ""}${info.credential ? ` <span class="badge">write-only</span>` : ""}</td>
<td>${esc(info.type)}${info.enumValues ? `<div class="hint">${esc(info.enumValues.join(" | "))}</div>` : ""}</td>
<td><code>${esc(settingText(info, info.default))}</code></td><td>${esc([info.label, info.description].filter(Boolean).join(" — "))}</td></tr>`,
	);
	return `<details><summary>All omp settings (${reference.length})</summary>
<label>Filter <input type="search" id="omp-ref-filter" placeholder="id or description"></label>
<table><thead><tr><th>Setting</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody id="omp-ref">
${rows.join("\n")}
</tbody></table></details>
<script>
document.getElementById("omp-ref-filter").addEventListener("input", event => {
	const query = event.target.value.trim().toLowerCase();
	for (const row of document.getElementById("omp-ref").rows) row.hidden = !!query && !row.textContent.toLowerCase().includes(query);
});
</script>`;
}

/** Who started an install, as the panel shows it. */
function startedBy(by: string): string {
	return by === AUTO_UPDATE_BY ? "started automatically" : `approved by ${by}`;
}

/**
 * WEB-33: the running omp (UPD-10: both versions when a copy is active), the npm check with **Check now**, **Approve
 * update** when a newer omp is on offer and no install runs, the current or last attempt, and `omp.autoUpdate`.
 */
export function updateSection(update: OmpUpdateView): string {
	const workers = update.active
		? `<p>Workers use omp <code>${esc(update.active.version)}</code> (in-place update ${esc(update.active.copy)}, ${esc(installedByText(update.active.by))}, ${(update.active.size / 1024 ** 2).toFixed(1)} MiB).
The orchestrator keeps the image's omp <code>${esc(update.image)}</code> for settings validation and sign-in.</p>`
		: `<p>Running omp <code>${esc(update.image)}</code> (the image's), used by the orchestrator and by workers.</p>`;
	const rows: [string, string][] = [
		["Latest found", update.latest ? `<code>${esc(update.latest)}</code>` : "not checked yet"],
		["Last check", update.checkedAt ? esc(formatTime(update.checkedAt)) : "never"],
	];
	if (update.checkError) rows.push(["Check error", `<span class="error">${esc(update.checkError)}</span>`]);
	const state = !update.supported
		? esc(update.unsupportedReason ?? "updates are not supported here")
		: update.installing
			? `installing omp ${esc(update.installing.version)} (${esc(startedBy(update.installing.by))} at ${esc(formatTime(update.installing.startedAt))})…`
			: update.available
				? `omp ${esc(update.available)} is available`
				: "up to date";
	rows.push(["Update", state]);
	rows.push(["Automatic updates", update.autoUpdate ? "on (<code>omp.autoUpdate</code>)" : 'off (turn on <code>omp.autoUpdate</code> in <a href="/admin">Settings</a>)']);
	const attempt = update.attempt;
	if (attempt) {
		const error = attempt.error ? `<div class="error">${esc(attempt.error)}</div>` : "";
		const log = attempt.log ? `<details><summary>Output</summary><pre>${esc(attempt.log)}</pre></details>` : "";
		rows.push([
			attempt.outcome === "installing" ? "Current attempt" : "Last attempt",
			`omp ${esc(attempt.version)} (from ${esc(attempt.from)}): <strong>${esc(attempt.outcome)}</strong>; ${esc(startedBy(attempt.by))}, ${esc(formatTime(attempt.at))}${error}${log}`,
		]);
	}
	const approve =
		update.supported && update.available && !update.installing
			? `<form method="post" action="/admin/omp/update-approve"><input type="hidden" name="version" value="${esc(update.available)}"><button type="submit">Approve update to omp ${esc(update.available)}</button></form>`
			: "";
	return `<section id="omp-update"><h2>omp version and updates</h2>
${workers}
<table><tbody>
${rows.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join("\n")}
</tbody></table>
<form method="post" action="/admin/omp/update-check"><button type="submit">Check now</button></form>
${approve}
</section>`;
}

/**
 * WEB-33: while an install runs, polls the update state and reloads when it changes, unless the settings form was
 * edited (then it says so instead of discarding the edits).
 */
function installPollScript(update: OmpUpdateView): string {
	if (!update.installing) return "";
	return `<script>
(function () {
	let dirty = false;
	document.getElementById("omp-settings")?.addEventListener("input", () => { dirty = true; });
	const started = ${JSON.stringify(update.installing.startedAt)};
	const timer = setInterval(async () => {
		try {
			const res = await fetch("/admin/omp/update.json", { headers: { accept: "application/json" } });
			if (!res.ok) return;
			const update = await res.json();
			if (update.installing && update.installing.startedAt === started) return;
			clearInterval(timer);
			if (!dirty) return location.reload();
			const note = document.createElement("p");
			note.className = "status";
			note.textContent = "The omp install finished; save or reload the page to see the result.";
			document.getElementById("omp-update").append(note);
		} catch {}
	}, 3000);
})();
</script>`;
}

export function ompPage(view: OmpView, form: OmpFormState, opts: { flash?: Flash; error?: string }): string {
	const byId = new Map(view.reference.map(info => [info.id, info]));
	const storedError = view.storedError
		? `<p class="warning">The stored omp configuration no longer validates (${esc(view.storedError)}); the form shows the stored overrides. Saving replaces them.</p>`
		: "";
	return layout(
		"omp",
		`${nav("omp")}
<h1>omp</h1>
${messages(opts.error, opts.flash)}
${updateSection(view.update)}
<p class="hint">Changes apply to agent runs that start after saving; runs already in progress keep the configuration they started with.</p>
${storedError}
<form method="post" action="/admin/omp" id="omp-settings">
${settingsSection(form, byId, view.reference)}
<button type="submit">Save omp settings</button>
</form>
${pinnedSection(view.pinned)}
${referenceSection(view.reference)}
${installPollScript(view.update)}`,
	);
}

/** The omp view, or a page explaining why it can't be shown (vault locked). */
async function loadView(ctx: PageContext): Promise<OmpView | Response> {
	try {
		return await ctx.admin.call<OmpView>("GET", "/omp");
	} catch (err) {
		if (!(err instanceof AdminApiError && err.status === 409)) throw err;
		return html(layout("omp", `${nav("omp")}<h1>omp</h1>${messages(err.message)}`), 409);
	}
}

/** The Check now flash: the npm result and what happens next. */
function checkedText(update: OmpUpdateView): string {
	const latest = `Checked npm: the latest omp is ${update.latest ?? "unknown"}.`;
	if (!update.available) return latest;
	if (update.installing) return `${latest} omp ${update.installing.version} is being installed (${startedBy(update.installing.by)}).`;
	return `${latest} omp ${update.available} is available for workers; approve it below.`;
}

export const ompPages: PageRoutes = {
	"GET /admin/omp": {
		async handle(_req, _url, ctx) {
			const view = await loadView(ctx);
			if (view instanceof Response) return view;
			const flash = ctx.session.flash;
			ctx.session.flash = undefined;
			return html(ompPage(view, ompFormFromView(view), { flash }));
		},
	},

	"GET /admin/omp/update.json": {
		json: true,
		handle: async (_req, _url, ctx) => json(await ctx.admin.call<OmpUpdateView>("GET", "/omp/update")),
	},

	"POST /admin/omp": {
		async handle(req, _url, ctx) {
			const form = await req.formData();
			try {
				await ctx.admin.call("PUT", "/omp", { body: ompSaveRequestFromForm(form), admin: ctx.session.username });
			} catch (err) {
				// 409: the vault locked meanwhile; loading the view answers with the locked page.
				if (!(err instanceof AdminApiError && (err.status === 400 || err.status === 409))) throw err;
				const view = await loadView(ctx);
				if (view instanceof Response) return view;
				return html(ompPage(view, ompFormFromSubmission(form, view), { error: err.message }), 400);
			}
			ctx.session.flash = { text: OMP_SAVED };
			return redirect("/admin/omp");
		},
	},

	"POST /admin/omp/update-check": {
		async handle(_req, _url, ctx) {
			const update = await ctx.admin.call<OmpUpdateView>("POST", "/omp/update-check", { admin: ctx.session.username });
			ctx.session.flash = update.checkError ? { text: `The npm check failed: ${update.checkError}`, error: true } : { text: checkedText(update) };
			return redirect("/admin/omp");
		},
	},

	/** UPD-03: a stale or concurrent approval comes back 409 and is shown as the error. */
	"POST /admin/omp/update-approve": {
		async handle(req, _url, ctx) {
			const version = field(await req.formData(), "version");
			try {
				await ctx.admin.call<OmpUpdateView>("POST", "/omp/update-approve", { body: { version }, admin: ctx.session.username });
				ctx.session.flash = { text: `Installing omp ${version} for workers. This page refreshes when the install ends.` };
			} catch (err) {
				if (!(err instanceof AdminApiError && (err.status === 400 || err.status === 409))) throw err;
				ctx.session.flash = { text: `The update was not started: ${err.message}`, error: true };
			}
			return redirect("/admin/omp");
		},
	},
};
