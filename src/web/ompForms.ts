import type { OmpSaveRequest, OmpSettingInfo, OmpView, SettingRow } from "../shared/adminOmp";
import { field, rowIndices } from "./forms";

/**
 * The omp page form (AGT-20) ↔ the admin API's save request. The orchestrator parses the values with omp's own parser
 * and fills in blank write-only values from what it stores; this module only reads and echoes the form.
 */

/** Everything the omp page form renders; holds no credential values. */
export interface OmpFormState {
	settings: SettingRow[];
	newSetting: { id: string; value: string };
}

/** Form text for a setting value: JSON for arrays and records, plain text otherwise. */
export function settingText(info: OmpSettingInfo | undefined, value: unknown): string {
	if (typeof value === "string") return value;
	if (info?.type === "array" || info?.type === "record") return JSON.stringify(value, null, 2);
	return value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Submitted settings: each kept row with an id, the add row last. */
function settingEntries(form: FormData): { id: string; value: string }[] {
	const entries: { id: string; value: string }[] = [];
	for (const i of rowIndices(form, "setting")) {
		if (form.has(`setting.${i}.remove`)) continue;
		const id = field(form, `setting.${i}.id`).trim();
		if (id) entries.push({ id, value: field(form, `setting.${i}.value`) });
	}
	const newId = field(form, "setting.new.id").trim();
	if (newId) entries.push({ id: newId, value: field(form, "setting.new.value") });
	return entries;
}

/** The omp page form as a save request. */
export function ompSaveRequestFromForm(form: FormData): OmpSaveRequest {
	return { settings: settingEntries(form) };
}

/** Form state for the stored configuration. */
export function ompFormFromView(view: OmpView): OmpFormState {
	return { settings: view.settings, newSetting: { id: "", value: "" } };
}

/** Form state echoing a rejected submission; credential values are dropped. */
export function ompFormFromSubmission(form: FormData, view: OmpView): OmpFormState {
	const reference = new Map(view.reference.map(info => [info.id, info]));
	const storedSettings = new Map(view.settings.map(row => [row.id, row]));
	const echo = (id: string, text: string): SettingRow => {
		const credential = reference.get(id)?.credential ?? false;
		return { id, value: credential ? "" : text, credentialSet: credential && storedSettings.has(id) };
	};
	const request = ompSaveRequestFromForm(form);
	const newId = field(form, "setting.new.id").trim();
	// The add row is the last entry when it has an id.
	const rows = newId ? request.settings.slice(0, -1) : request.settings;
	return {
		settings: rows.map(row => echo(row.id, row.value)),
		newSetting: newId ? echo(newId, field(form, "setting.new.value")) : { id: "", value: "" },
	};
}
