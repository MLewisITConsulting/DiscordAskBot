import type { Loadout } from "./agent";
import type { Config } from "./config";
import type { RunUsage } from "./transcript";
import type { WorkerPhase } from "./wire";

/**
 * Web ↔ orchestrator admin API (architecture §4.5 `/internal/admin/*`). The web pod holds no database or vault: every
 * read and write goes through these routes. Auth: `Authorization: Bearer <web-api-token>` (SEC-14, constant-time compare).
 * The admin acting is passed as `X-Askbot-Admin: <username>` on writes so the orchestrator can log it.
 * Errors: non-2xx with `{ error: string }`; 400 = validation (message is shown to the admin), 401 = bad web token,
 * 409 = wrong vault state (e.g. setup after setup), 429 never (the login throttle lives in web, WEB-03).
 *
 * Phase 2 routes; later phases add more under the same prefix.
 */
export const ADMIN_PREFIX = "/internal/admin";

export type EnginePhase = "setup" | "locked" | "unconfigured" | "starting" | "running" | "stopping" | "error";

/** GET /internal/admin/state */
export interface AdminState {
	phase: EnginePhase;
	/** Startup error of the last apply (shown to the admin; never in health bodies). */
	error?: string;
	since: string;
	/** An admin account exists (else web serves /setup). */
	initialized: boolean;
	unlocked: boolean;
	username?: string;
	version: string;
	/** Home page facts (§9.3 `/`). */
	home: HomeFacts;
}

/**
 * Counts and getting-started progress for the home page (requirements §5.3 `/`). Counts are absent while they can't be
 * read (the vault is locked, or no reader is wired); a step whose data can't be read is not done.
 */
export interface HomeFacts {
	modelAccounts?: number;
	checklist: {
		/** The admin account exists (WEB-02). */
		setup: boolean;
		/** The Discord bot token is saved. */
		botToken: boolean;
		/** `discord.guildId` is saved. */
		guild: boolean;
		/** At least one allowed user or role is saved (DSC-02). */
		allowedUsers: boolean;
		/** At least one ask-only channel is chosen (ENG-02). */
		askChannel: boolean;
		/** A model sign-in or a provider API key exists. */
		modelAccess: boolean;
	};
}

/** POST /internal/admin/setup — WEB-02. 400 on a bad token/username/password, 409 once an admin exists. */
export interface SetupRequest {
	token: string;
	username: string;
	password: string;
}

/** POST /internal/admin/login — WEB-03 (the vault always pays the scrypt cost). Unlocks the vault, enrols a master key (SEC-05), applies settings. */
export interface LoginRequest {
	username: string;
	password: string;
}
export interface LoginResponse {
	ok: boolean;
}

/** POST /internal/admin/credentials — WEB-04. 400 `{error}` when the current password is wrong. Web ends the other sessions. */
export interface CredentialsRequest {
	currentPassword: string;
	username: string;
	password: string;
}

/** Secrets as the admin sees them: only whether each is set (write-only, requirements §5.3 `/admin`). */
export interface SecretsView {
	discordToken: boolean;
	/** Provider ids that have a key. */
	providerKeys: string[];
}

/** GET /internal/admin/settings — 409 while locked. `config` is undefined until settings are saved. */
export interface SettingsView {
	config?: Config;
	secrets: SecretsView;
}

/**
 * PUT /internal/admin/settings — validated as a whole (requirements §9); a blank or absent secret keeps the stored value;
 * `providerKeys` entries with an empty value delete that key. On success the orchestrator applies the settings (ENG-02)
 * and answers with the resulting phase. 400 `{error}` on validation failure, nothing stored.
 */
export interface SettingsSaveRequest {
	config: unknown;
	secrets: { discordToken?: string; providerKeys?: Record<string, string> };
}
export interface SettingsSaveResponse {
	phase: EnginePhase;
	error?: string;
	warnings: string[];
}

export type UsageWindow = "24h" | "7d" | "30d" | "all";

/** A connected worker (architecture §6: every connected worker is listed, so an unknown one stands out). */
export interface WorkerStatus {
	/** Pod or container name. */
	id: string;
	address: string;
	version: string;
	/** omp version of its run (after `run-info`), else of its image. */
	ompVersion: string;
	runId?: string;
	phase?: WorkerPhase;
	connectedAt: string;
}

/**
 * A run that has not finished (requirements §5.3 `/status`: pending runs and their age, runs in progress). Setup time is
 * the time from the claim to the agent starting — worker start and downloads (NFR-06).
 */
export interface RunStatus {
	id: string;
	state: "pending" | "assigned" | "running" | "finishing";
	/** The ask thread that owns the run. */
	threadId: string;
	workerId?: string;
	/** When the run became pending. */
	createdAt: string;
	/** The latest claim by a worker. */
	claimedAt?: string;
	/** The agent started (the host `registered`). */
	startedAt?: string;
	/** `startedAt − claimedAt`; absent until the agent started. */
	setupMs?: number;
	/** The tool of the latest progress report. */
	lastTool?: string;
	/** Live usage (latest progress report); zero until the first one. */
	usage: RunUsage;
	/** The run's loadout once the agent reported it (AGT-27). */
	loadout?: Loadout;
}

/** Usage totals of one group (an ask channel or a Discord user) in the window (OBS-06). */
export interface UsageGroup {
	id: string;
	runs: number;
	costUsd: number;
	tokensIn: number;
	tokensOut: number;
}

/** GET /internal/admin/status?window=7d — the status page and `/status.json` (requirements §5.3). */
export interface StatusReport {
	state: AdminState;
	engine?: {
		startedAt: string;
		discord: { ready: boolean; user?: string; pingMs?: number; nicknameWarning?: string };
		/** DSC-32. */
		discordQueue: { length: number; oldestAgeMs: number | null };
	};
	runs: { pending: number; running: number; oldestPendingMs: number | null };
	/** Unfinished runs, oldest first: pending ones with their age, and runs in progress (NFR-06). */
	activeRuns: RunStatus[];
	workers: WorkerStatus[];
	limits: {
		maxChatSessions: number;
		maxConcurrentRuns: number;
		workerCapacity: number;
		effectiveConcurrency: number;
	} | null;
	warnings: string[];
	/** Ask threads with a pending or active run. */
	activeThreads: { threadId: string; channelId: string; ownerId: string }[];
	usage: {
		window: UsageWindow;
		since?: string;
		totals: { runs: number; costUsd: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number };
		/** By ask channel and by Discord user, highest cost first (OBS-06). */
		byChannel: UsageGroup[];
		byUser: UsageGroup[];
		/** Run counts by outcome and the average duration (OBS-06). */
		outcomes: { finished: number; failed: number; stopped: number; limit: number; avgDurationMs: number | null };
		/** Cost per UTC day for the last 14 days, zero days included (OBS-06). */
		daily: { day: string; costUsd: number }[];
		/** NFR-06: setup time (claim → agent start) of runs started in the window. */
		setup: { runs: number; avgMs: number; maxMs: number } | null;
	};
	/** The latest loadout of the `ask` profile (AGT-27). */
	loadout?: Loadout;
}
