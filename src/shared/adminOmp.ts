/**
 * Admin API for the omp configuration (AGT-20, AGT-23) and in-place omp updates (UPD-02, UPD-03, WEB-33), under
 * `/internal/admin`. The configuration lives in the vault; credential settings are write-only and never leave the
 * orchestrator.
 *
 * - `GET /omp` → {@link OmpView} (409 while the vault is locked)
 * - `PUT /omp` {@link OmpSaveRequest} → `{ ok: true }` (400 with omp's parser message; 409 while locked)
 * - `GET /omp/update` → {@link OmpUpdateView}: the update panel alone, for the page's refresh while an install runs
 * - `POST /omp/update-check` → {@link OmpUpdateView}: asks the npm registry now (UPD-02, the page's **Check now**)
 * - `POST /omp/update-approve` {@link OmpApproveRequest} → {@link OmpUpdateView}: starts the UPD-03 install, recorded
 *   with the acting admin's username; 409 when `version` is no longer on offer or an install is already running
 */

/** One registered omp setting, for the reference and the override editor. */
export interface OmpSettingInfo {
	id: string;
	type: "boolean" | "number" | "string" | "enum" | "array" | "record";
	default: unknown;
	enumValues?: readonly string[];
	label?: string;
	description?: string;
	/** Write-only: a stored value is never sent back. */
	credential: boolean;
	/** Set when AskBot pins this setting: why. */
	locked?: string;
}

/** A setting AskBot pins (AGT-20): shown, never editable. */
export interface PinnedSetting {
	id: string;
	value: unknown;
	reason: string;
}

/** One override. Credential values are never carried: `value` is "" and `credentialSet` says whether one is stored. */
export interface SettingRow {
	id: string;
	/** Form text: JSON for arrays and records, plain text otherwise. */
	value: string;
	credentialSet: boolean;
}

export interface OmpView {
	/** omp versions and in-place worker updates (WEB-33). */
	update: OmpUpdateView;
	/** Every registered omp setting, in omp's display order. */
	reference: OmpSettingInfo[];
	pinned: PinnedSetting[];
	settings: SettingRow[];
	/** The stored configuration no longer validates (e.g. omp dropped a setting); what is shown is what still parses. */
	storedError?: string;
}

/** The whole configuration as submitted: replaces the stored one (a blank credential setting keeps its stored value). */
export interface OmpSaveRequest {
	/** Setting id → form text, parsed by omp's own parser. */
	settings: { id: string; value: string }[];
}

/** Approve the update on offer (UPD-03). */
export interface OmpApproveRequest {
	/** The version shown on the page; a stale one is refused. */
	version: string;
}

/** One in-place update attempt (UPD-03, UPD-08): an approval or automatic install and what came of it. */
export interface OmpAttempt {
	version: string;
	/** The omp workers used when it started. */
	from: string;
	/** The admin's username, or `AUTO_UPDATE_BY` for an automatic install. */
	by: string;
	/** `failed` covers a failed install, a copy that failed its canary run (UPD-08) and a restart during the install. */
	outcome: "installing" | "installed" | "failed";
	error?: string;
	/** Tail of the install output, or of the failed agent host's stderr. */
	log?: string;
	/** The runtime copy it made. */
	copy?: string;
	at: string;
}

/** omp version and update state for the omp page (WEB-33, UPD-10). */
export interface OmpUpdateView {
	/** The image's omp: the orchestrator's, and the workers' when no copy is active. */
	image: string;
	/** The active runtime copy new workers use (UPD-07); absent when workers use the image's omp. */
	active?: { copy: string; version: string; size: number; createdAt: string; by: string };
	/** npm's latest, as of `checkedAt`. */
	latest?: string;
	checkedAt?: string;
	/** The last check failed with this (UPD-02). */
	checkError?: string;
	/** `latest` when it is newer than the omp new workers would use. */
	available?: string;
	/** False outside the container image (no `ASKBOT_OMP_RUNTIME_DIR`): updates are refused (UPD-05). */
	supported: boolean;
	unsupportedReason?: string;
	installing?: { version: string; by: string; startedAt: string };
	/** The current or last attempt. */
	attempt?: OmpAttempt;
	/** `omp.autoUpdate` (UPD-02). */
	autoUpdate: boolean;
}

/** The `by` of an install started by `omp.autoUpdate` instead of an approval. */
export const AUTO_UPDATE_BY = "auto-update";

/** "installed automatically" or "approved by alice", for the omp page. */
export function installedByText(by: string): string {
	return by === AUTO_UPDATE_BY ? "installed automatically" : `approved by ${by}`;
}
