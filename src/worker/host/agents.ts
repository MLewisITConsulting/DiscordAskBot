import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { agentProblem } from "../../shared/agentRules";
import { errorMessage, log } from "../../shared/log";

export interface ValidAgent {
	name: string;
	description: string;
}

/**
 * AGT-31: the worker's own check of the downloaded task agents, before the session starts. Every entry of
 * `<ompDir>/agents` that is not a regular `<frontmatter name>.md` file passing AGT-25 is deleted, so omp (which keeps
 * the first file of a name and gives a child whatever its frontmatter names) can never load it (spike A2).
 * Returns the valid agents, sorted by name: the session's `spawns` allowlist.
 */
export async function validateAgents(ompDir: string, run: string): Promise<ValidAgent[]> {
	const dir = join(ompDir, "agents");
	const entries = await readdir(dir, { withFileTypes: true }).catch(err => {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	});
	const valid: ValidAgent[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		const fileName = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
		let name = fileName;
		let description = "";
		let reason: string | undefined;
		if (!entry.isFile()) reason = "not a regular file";
		else if (!entry.name.endsWith(".md")) reason = "not a .md file";
		else {
			try {
				const { frontmatter } = parseFrontmatter(await readFile(path, "utf8"), { location: path, level: "fatal" });
				if (typeof frontmatter.name === "string") name = frontmatter.name;
				if (typeof frontmatter.description === "string") description = frontmatter.description;
				reason = agentProblem(frontmatter);
				if (!reason && frontmatter.name !== fileName) reason = `file ${entry.name} must be named ${String(frontmatter.name)}.md`;
			} catch (err) {
				reason = `unreadable frontmatter: ${errorMessage(err)}`;
			}
		}
		if (reason) {
			log("warn", "agent skipped", { run, name, reason });
			await rm(path, { recursive: true, force: true });
		} else valid.push({ name, description });
	}
	return valid.sort((a, b) => a.name.localeCompare(b.name));
}
