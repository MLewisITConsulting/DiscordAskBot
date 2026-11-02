import { z } from "zod";
import type { OmpApproveRequest, OmpSaveRequest, OmpView, SettingRow } from "../../shared/adminOmp";
import { errorMessage, log } from "../../shared/log";
import { emptyOmpConfig, LOCKED_SETTINGS, listSettings, type OmpConfig, OmpConfigError, parseOmpConfig, parseSettingValue, type SettingInfo } from "../../shared/ompconfig";
import type { OmpUpdater } from "../omp/updates";
import type { Vault } from "../store/vault";
import { type AdminRoutes, actingAdmin, fail, HttpError, jsonBody, str } from "./http";

/**
 * `/internal/admin/omp*`: omp setting overrides (AGT-20, AGT-23) and the update panel (WEB-33, architecture §8); the
 * contract is in `src/shared/adminOmp.ts`. The configuration is stored in the vault and read by the dispatcher when a run
 * is claimed, so a save applies to runs that start afterwards (AGT-23).
 */

export interface OmpRoutesDeps {
	vault: Vault;
	/** In-place worker updates: their state, the manual check and the approval (UPD-02, UPD-03). */
	updates: Pick<OmpUpdater, "status" | "check" | "install">;
}

let settingsCache: { list: SettingInfo[]; byId: Map<string, SettingInfo> } | undefined;

/** Every registered omp setting, read once (550+). Keyed by user-supplied ids, so a Map (no prototype keys). */
export function ompSettings(): { list: SettingInfo[]; byId: Map<string, SettingInfo> } {
	if (!settingsCache) {
		const list = listSettings();
		settingsCache = { list, byId: new Map(list.map(info => [info.id, info])) };
	}
	return settingsCache;
}

/** Form text for a stored setting value: JSON for arrays and records, plain text otherwise; what `parseSettingValue` reads. */
export function settingText(info: SettingInfo | undefined, value: unknown): string {
	if (typeof value === "string") return value;
	if (info?.type === "array" || info?.type === "record") return JSON.stringify(value, null, 2);
	return value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

const saveSchema = z.object({
	settings: z.array(z.object({ id: z.string(), value: z.string() })).default([]),
});

/**
 * The submitted configuration, validated as omp would load it. Setting values go through omp's own parser (pinned ones
 * are refused); a blank credential setting keeps what `previous` stores. Throws `OmpConfigError`.
 */
export function ompConfigFromRequest(req: OmpSaveRequest, previous: OmpConfig): OmpConfig {
	const { byId } = ompSettings();
	const settings: Record<string, unknown> = {};
	for (const { id: rawId, value } of req.settings) {
		const id = rawId.trim();
		if (!id) continue;
		const keep = byId.get(id)?.credential && !value.trim() && Object.hasOwn(previous.settings, id);
		settings[id] = keep ? previous.settings[id] : parseSettingValue(id, value);
	}
	return parseOmpConfig({ settings });
}

/** The stored configuration (an unlocked vault); `error` when it no longer validates (then the raw overrides, to fix). */
export function storedOmpConfig(vault: Pick<Vault, "readOmpConfig">): { config: OmpConfig; error?: string } {
	const raw = vault.readOmpConfig();
	if (raw === undefined) return { config: emptyOmpConfig() };
	try {
		return { config: parseOmpConfig(raw) };
	} catch (err) {
		const settings = raw && typeof raw === "object" && "settings" in raw && raw.settings && typeof raw.settings === "object" ? { ...raw.settings } : {};
		return { config: { settings }, error: errorMessage(err) };
	}
}

function settingRows(config: OmpConfig): SettingRow[] {
	const { byId } = ompSettings();
	return Object.entries(config.settings).map(([id, value]) => {
		const info = byId.get(id);
		return info?.credential ? { id, value: "", credentialSet: true } : { id, value: settingText(info, value), credentialSet: false };
	});
}

export function createOmpRoutes(deps: OmpRoutesDeps): AdminRoutes {
	const { vault, updates } = deps;

	function storedConfig(): { config: OmpConfig; error?: string } {
		if (!vault.isInitialized() || !vault.isUnlocked()) throw new HttpError(409, "Settings are locked; log in to unlock them.");
		return storedOmpConfig(vault);
	}

	function view(): OmpView {
		const { config, error } = storedConfig();
		return {
			update: updates.status(),
			reference: ompSettings().list,
			pinned: Object.entries(LOCKED_SETTINGS).map(([id, { value, reason }]) => ({ id, value, reason })),
			settings: settingRows(config),
			...(error ? { storedError: error } : {}),
		};
	}

	async function save(req: Request): Promise<Response> {
		const previous = storedConfig().config;
		const parsed = saveSchema.safeParse(await jsonBody<OmpSaveRequest>(req));
		if (!parsed.success) {
			const issue = parsed.error.issues[0]!;
			return fail(400, `Invalid request: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
		}
		let config: OmpConfig;
		try {
			config = ompConfigFromRequest(parsed.data, previous);
		} catch (err) {
			if (err instanceof OmpConfigError) return fail(400, err.message);
			throw err;
		}
		vault.writeOmpConfig(config);
		log("info", "omp configuration saved", { admin: actingAdmin(req), settings: Object.keys(config.settings).length });
		return Response.json({ ok: true });
	}

	/** UPD-03: claims the install before anything is awaited, so a stale or second concurrent approval gets 409. */
	async function approve(req: Request): Promise<Response> {
		const version = str((await jsonBody<OmpApproveRequest>(req)).version).trim();
		if (!version) return fail(400, "No version to approve.");
		const admin = actingAdmin(req);
		if (!admin) return fail(400, "The approving admin is missing.");
		const start = updates.install(version, admin);
		if (!start.started) {
			log("warn", "omp update approval refused", { admin, version, error: start.error });
			return fail(409, start.error);
		}
		log("info", "omp update approved", { admin, version });
		return Response.json(updates.status());
	}

	return {
		"/omp": {
			methods: ["GET", "PUT"],
			handle: async req => (req.method === "GET" ? Response.json(view()) : save(req)),
		},
		"/omp/update": { methods: ["GET"], handle: async () => Response.json(updates.status()) },
		"/omp/update-check": {
			methods: ["POST"],
			async handle(req) {
				log("info", "omp update check requested", { admin: actingAdmin(req) });
				return Response.json(await updates.check());
			},
		},
		"/omp/update-approve": { methods: ["POST"], handle: approve },
	};
}
