import { AUTO_UPDATE_BY, type OmpAttempt, type OmpUpdateView, installedByText } from "../../shared/adminOmp";
import { errorMessage, log } from "../../shared/log";
import { OMP_PACKAGE, outputTail, SEMVER } from "../../shared/ompPins";
import type { AppIdentity } from "../../shared/version";
import type { OmpRuntimeSpec, WorkerControl } from "../../shared/wire";
import type { Db } from "../store/db";
import { type CopyInstaller, imageInstaller, type OmpRuntimes, openOmpRuntimes } from "./runtime";

/**
 * In-place omp updates for workers (requirements UPD-02 to UPD-05, architecture UPD-06 to UPD-10). The orchestrator
 * checks npm, and on an approval on `/admin/omp` (WEB-33), or automatically with `omp.autoUpdate`, installs the new omp
 * as a packed runtime copy that new workers download (UPD-07); nothing restarts, and the orchestrator itself keeps the
 * image's omp (UPD-10). Check results and the last attempt are kept in `kv` (architecture §8 "State"); nothing goes to
 * Discord.
 */

export const REGISTRY_URL = `https://registry.npmjs.org/${OMP_PACKAGE}/latest`;
export const UNSUPPORTED = "omp updates run only in the container image (ASKBOT_OMP_RUNTIME_DIR is not set)";

const KEY_LATEST = "omp.update.latest";
const KEY_CHECKED_AT = "omp.update.checkedAt";
const KEY_CHECK_ERROR = "omp.update.checkError";
const KEY_ATTEMPT = "omp.update.attempt";

const CHECK_TIMEOUT_MS = 10_000;

export type InstallResult = { ok: true; copy: string } | { ok: false; error: string; log?: string };

/** An install request: refused at once (stale, already installing, outside the image), or started with its outcome to come. */
export type InstallStart = { started: false; error: string } | { started: true; done: Promise<InstallResult> };

/** What the worker dispatcher needs: the copy for a run's spec, its archive, and canary failures (UPD-07, UPD-08). */
export interface OmpRuntimeSource {
	forRun(runId: string): OmpRuntimeSpec | undefined;
	archive(runId: string): { stream: ReadableStream<Uint8Array>; size: number } | undefined;
	canaryFailed(report: Omit<Extract<WorkerControl, { t: "omp-runtime-failed" }>, "t">): void;
}

export interface OmpUpdater extends OmpRuntimeSource {
	status(): OmpUpdateView;
	/**
	 * Asks the npm registry (10 s timeout); failures are stored as `checkError`. Never throws. With `omp.autoUpdate` on,
	 * a newer omp is then installed at once (UPD-02).
	 */
	check(): Promise<OmpUpdateView>;
	/** UPD-09 cleanup, then a check after `checkDelayMs` and every `checkIntervalMs`. */
	start(): void;
	stop(): void;
	/**
	 * UPD-06 for `version`, started by `by` (the admin's username, or `AUTO_UPDATE_BY`). Claims the install
	 * synchronously, so a stale request and a second concurrent one are refused (UPD-03).
	 */
	install(version: string, by: string): InstallStart;
}

export interface OmpUpdaterOptions {
	db: Pick<Db, "kvGet" | "kvSet" | "runsInState">;
	/** `ASKBOT_OMP_RUNTIME_DIR`; undefined outside the container image, where updates are refused (UPD-05). */
	runtimeDir?: string;
	/** This orchestrator's app identity, recorded on every copy (`/app/IDENTITY`, architecture §7.1). */
	identity: AppIdentity;
	/** The image's omp version. */
	imageOmpVersion: string;
	/** `omp.autoUpdate` from the stored settings (off while they are locked or unsaved). */
	autoUpdate?: () => boolean;
	/** Makes the copy's app tree; default `imageInstaller` over `imageAppDir`. */
	installer?: CopyInstaller;
	/** The image's app root, copied by the default installer. */
	imageAppDir: string;
	/** npm's `latest` document for omp; tests point it at a fake registry. */
	registryUrl?: string;
	/** UPD-02: first check 60 s after start, then every 6 h. */
	checkDelayMs?: number;
	checkIntervalMs?: number;
}

function parseJson<T>(text: string | undefined): T | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function createOmpUpdater(opts: OmpUpdaterOptions): OmpUpdater {
	const { db, imageOmpVersion: image } = opts;
	const registryUrl = opts.registryUrl ?? REGISTRY_URL;
	const installer = opts.installer ?? imageInstaller({ imageAppDir: opts.imageAppDir });
	const runtimes: OmpRuntimes | undefined = opts.runtimeDir
		? openOmpRuntimes({ dir: opts.runtimeDir, identity: opts.identity, assignedRuns: () => db.runsInState("assigned").map(row => row.id) })
		: undefined;
	let installing: OmpUpdateView["installing"];
	let stopped = false;
	let firstCheck: ReturnType<typeof setTimeout> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	const readAttempt = () => parseJson<OmpAttempt>(db.kvGet(KEY_ATTEMPT));
	const saveAttempt = (attempt: OmpAttempt) => db.kvSet(KEY_ATTEMPT, JSON.stringify(attempt));
	/** The omp new workers use: the active copy's, else the image's. */
	const workerVersion = () => runtimes?.active()?.version ?? image;

	// An install the orchestrator did not live to finish.
	const unfinished = readAttempt();
	if (unfinished?.outcome === "installing") {
		saveAttempt({ ...unfinished, outcome: "failed", error: "the orchestrator restarted during the install", at: new Date().toISOString() });
	}

	function latest(): string | undefined {
		const value = db.kvGet(KEY_LATEST);
		return value && SEMVER.test(value) ? value : undefined;
	}

	function autoUpdateOn(): boolean {
		try {
			return opts.autoUpdate?.() ?? false;
		} catch (err) {
			log("warn", "could not read omp.autoUpdate", { error: errorMessage(err) });
			return false;
		}
	}

	/** npm's latest when it is newer than the omp new workers would use. */
	function updateAvailable(): string | undefined {
		const version = latest();
		const current = workerVersion();
		if (!version || !SEMVER.test(current)) return undefined;
		return Bun.semver.order(version, current) > 0 ? version : undefined;
	}

	function status(): OmpUpdateView {
		const active = runtimes?.active();
		const available = updateAvailable();
		return {
			image,
			...(active ? { active: { copy: active.copy, version: active.version, size: active.size, createdAt: active.createdAt, by: active.by } } : {}),
			latest: latest(),
			checkedAt: db.kvGet(KEY_CHECKED_AT) || undefined,
			checkError: db.kvGet(KEY_CHECK_ERROR) || undefined,
			...(available ? { available } : {}),
			supported: runtimes !== undefined,
			...(runtimes ? {} : { unsupportedReason: UNSUPPORTED }),
			...(installing ? { installing: { ...installing } } : {}),
			attempt: readAttempt(),
			autoUpdate: autoUpdateOn(),
		};
	}

	async function check(): Promise<OmpUpdateView> {
		try {
			const res = await fetch(registryUrl, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
			const body = (await res.json()) as { version?: unknown };
			if (typeof body.version !== "string" || !SEMVER.test(body.version)) throw new Error("the npm registry returned no valid version");
			db.kvSet(KEY_LATEST, body.version);
			db.kvSet(KEY_CHECKED_AT, new Date().toISOString());
			db.kvSet(KEY_CHECK_ERROR, "");
			log("info", "omp update check", { latest: body.version, workers: workerVersion(), image });
		} catch (err) {
			db.kvSet(KEY_CHECK_ERROR, errorMessage(err));
			log("warn", "omp update check failed", { error: errorMessage(err) });
		}
		autoInstall();
		return status();
	}

	async function runInstall(runtimes: OmpRuntimes, base: OmpAttempt): Promise<InstallResult> {
		const { version, by } = base;
		try {
			const result = await runtimes.create({ version, by, installer });
			const at = new Date().toISOString();
			if (result.ok) {
				saveAttempt({ ...base, outcome: "installed", copy: result.copy.copy, log: outputTail(result.output), at });
				log("info", "omp update installed for workers", { version, copy: result.copy.copy, sizeBytes: result.copy.size });
				return { ok: true, copy: result.copy.copy };
			}
			const tail = outputTail(result.output);
			saveAttempt({ ...base, outcome: "failed", error: result.error, log: tail, at });
			log("error", "omp update failed", { version, error: result.error });
			return { ok: false, error: result.error, log: tail };
		} catch (err) {
			saveAttempt({ ...base, outcome: "failed", error: errorMessage(err), at: new Date().toISOString() });
			log("error", "omp update failed", { version, error: errorMessage(err) });
			return { ok: false, error: errorMessage(err) };
		} finally {
			installing = undefined;
			// A newer omp found while this one installed starts now (UPD-02).
			if (!stopped) autoInstall();
		}
	}

	function install(version: string, by: string): InstallStart {
		const refuse = (error: string): InstallStart => ({ started: false, error });
		if (!runtimes) return refuse(UNSUPPORTED);
		if (installing) return refuse(`omp ${installing.version} is already being installed (${installedByText(installing.by)})`);
		if (version !== updateAvailable()) return refuse(`omp ${version} is no longer the update on offer`);
		const startedAt = new Date().toISOString();
		installing = { version, by, startedAt };
		const base: OmpAttempt = { version, from: workerVersion(), by, outcome: "installing", at: startedAt };
		saveAttempt(base);
		log("info", "omp update started", { version, from: base.from, by });
		return { started: true, done: runInstall(runtimes, base) };
	}

	/**
	 * UPD-02, UPD-03: with `omp.autoUpdate` on, installs the update on offer. Reads the state and claims the install in
	 * one synchronous step, so a concurrent approval is refused. A version whose last attempt failed (install, canary or
	 * a restart during the install) is not installed automatically again; a newer version or an approval can try.
	 */
	function autoInstall(): void {
		const version = updateAvailable();
		if (!version || !runtimes || installing || !autoUpdateOn()) return;
		const attempt = readAttempt();
		if (attempt?.version === version && attempt.outcome === "failed") return;
		const start = install(version, AUTO_UPDATE_BY);
		if (!start.started) log("warn", "automatic omp install refused", { version, error: start.error });
	}

	function canaryFailed(report: Omit<Extract<WorkerControl, { t: "omp-runtime-failed" }>, "t">): void {
		const how = report.signal ? `signal ${report.signal}` : `code ${report.exitCode}`;
		const error = `the agent host from omp ${report.version} exited with ${how} before it registered (run ${report.runId}); workers use the image's omp ${image} again`;
		// Several workers may hit a broken copy at once: the first report counts.
		if (!runtimes?.markFailed(report.copy, error)) return;
		const attempt = readAttempt();
		const base: OmpAttempt =
			attempt?.copy === report.copy ? attempt : { version: report.version, from: image, by: "unknown", outcome: "failed", copy: report.copy, at: "" };
		saveAttempt({ ...base, outcome: "failed", error, log: outputTail(report.output), at: new Date().toISOString() });
		log("error", "omp runtime copy failed its canary run", { copy: report.copy, version: report.version, run: report.runId, exitCode: report.exitCode, signal: report.signal });
	}

	return {
		status,
		check,
		start() {
			if (firstCheck || interval) return;
			runtimes?.reconcile();
			firstCheck = setTimeout(() => {
				void check();
				interval = setInterval(() => void check(), opts.checkIntervalMs ?? 6 * 3_600_000);
				interval.unref?.();
			}, opts.checkDelayMs ?? 60_000);
			firstCheck.unref?.();
		},
		stop() {
			stopped = true;
			clearTimeout(firstCheck);
			clearInterval(interval);
			firstCheck = interval = undefined;
			runtimes?.close();
		},
		install,
		forRun: runId => runtimes?.forRun(runId),
		archive: runId => runtimes?.archive(runId),
		canaryFailed,
	};
}
