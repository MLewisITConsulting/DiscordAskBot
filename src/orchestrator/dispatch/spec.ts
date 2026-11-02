import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { emptyOmpConfig, parseOmpConfig } from "../../shared/ompconfig";
import type { CredentialSnapshot, OmpRuntimeSpec, RunSpec } from "../../shared/wire";
import type { RunRow } from "../store/db";
import { isSessionKey, sessionDir, sessionPath } from "../store/sessions";
import type { RunRequest } from "./dispatcher";

/**
 * Builds the run spec a worker gets with `assign` (architecture §4.2). It is assembled at claim time, so the credentials
 * snapshot and the omp settings are as fresh as possible (CRED-02, AGT-23), and it is never written to disk.
 */

/** Where the spec's parts come from; all read at claim time. */
export interface SpecSources {
	stateDir: string;
	/** The omp configuration as stored in the vault (validated here); undefined when none was saved. */
	ompConfig(): unknown;
	/** Provider API keys from the settings. */
	providerKeys(): Record<string, string>;
	/** Snapshot of the model sign-ins, refreshed first when they expire within 10 minutes (CRED-02). */
	credentials(): Promise<CredentialSnapshot[]>;
	/** Content hash of the skills and agents bundle (AGT-24). */
	skillsHash(): Promise<string>;
}

/** Why `req` cannot run on a worker, or undefined. */
export function unrunnableReason(req: RunRequest): string | undefined {
	if (!isSessionKey(req.session)) return `invalid session key ${JSON.stringify(req.session)}`;
	return undefined;
}

/** Regular files directly in `dir`, by name; none when it does not exist. */
async function regularFiles(dir: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const name of names.sort()) {
		if (name.startsWith(".")) continue;
		const stat = await lstat(join(dir, name)).catch(() => undefined);
		if (stat?.isFile()) files.push(name);
	}
	return files;
}

/** `ompRuntime`: the active omp runtime copy the run is given (UPD-07), if any. */
export async function buildRunSpec(row: RunRow, req: RunRequest, src: SpecSources, ompRuntime?: OmpRuntimeSpec): Promise<RunSpec> {
	const reason = unrunnableReason(req);
	if (reason) throw new Error(reason);
	const raw = src.ompConfig();
	const omp = raw === undefined ? emptyOmpConfig() : parseOmpConfig(raw);
	const [credentials, skillsHash, inputs] = await Promise.all([src.credentials(), src.skillsHash(), regularFiles(join(req.scratchDir, "inputs"))]);
	return {
		runId: row.id,
		profile: req.profile,
		prompt: req.prompt,
		...(req.outputSchema ? { outputSchema: req.outputSchema } : {}),
		...(req.model ? { model: req.model } : {}),
		thinking: req.thinking,
		limits: req.limits,
		resumeSession: req.resume && existsSync(sessionPath(sessionDir(src.stateDir), req.session)),
		omp,
		skillsHash,
		providerKeys: src.providerKeys(),
		credentials,
		scratch: { inputs },
		...(ompRuntime ? { ompRuntime } : {}),
	};
}
