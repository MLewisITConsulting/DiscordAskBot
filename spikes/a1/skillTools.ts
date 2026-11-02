/**
 * Spike A1: the ask profile's scratch tools (copied from src/worker/host/scratchTools.ts, trimmed to text files) plus
 * `skill://` resolution (AGT-30). `read_file` declares `readsSkillUris: true` so omp lists the skills in the prompt.
 */
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type CustomTool, zod } from "@oh-my-pi/pi-coding-agent";

const READ_MAX_BYTES = 256 * 1024;
const READ_DEFAULT_LINES = 2000;
const LIST_MAX_ENTRIES = 500;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** `skill://<name>` or `skill://<name>/<relative path>`; the name rule is AGT-25's. */
const SKILL_URI = /^skill:\/\/([^/]*)(?:\/(.*))?$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every raw `path` argument the tools received, for the spike's evidence. */
export const calls: { tool: string; path: string | undefined; ok: boolean; error?: string }[] = [];

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realExisting(path: string): Promise<string> {
	let current = path;
	for (;;) {
		try {
			return await realpath(current);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			const parent = dirname(current);
			if (parent === current) throw err;
			current = parent;
		}
	}
}

/** Unchanged from scratchTools.ts: AGT-28 confinement. */
export async function resolveInside(root: string, rel: string): Promise<string> {
	if (rel.includes("\0")) throw new Error("Invalid path");
	if (URL_SCHEME.test(rel)) throw new Error(`Only files in your workspace are available, not ${rel}`);
	if (isAbsolute(rel) || rel.startsWith("~")) throw new Error("Use a path relative to your workspace, such as inputs/data.csv");
	const abs = resolve(root, rel);
	if (!isInside(resolve(root), abs)) throw new Error("The path is outside your workspace");
	const realRoot = await realpath(root);
	if (!isInside(realRoot, await realExisting(abs))) throw new Error("The path is outside your workspace");
	try {
		if ((await lstat(abs)).isSymbolicLink()) throw new Error("Symbolic links are not available");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	return abs;
}

export interface ToolRoots {
	/** The thread's scratch directory. */
	scratch: string;
	/** `<ompDir>/skills`: the run's copy of the admin's skills. */
	skills: string;
}

/**
 * Absolute path for a tool's `path` argument. `skill://<name>[/<rel>]` resolves inside `<skills>/<name>` with the same
 * confinement as scratch paths (the skill folder is the root, so `..` cannot reach a sibling skill); anything else is a
 * scratch path. `skill: true` in the result means read-only.
 */
export async function resolveToolPath(roots: ToolRoots, path: string): Promise<{ abs: string; skill: boolean }> {
	const m = SKILL_URI.exec(path);
	if (!m) return { abs: await resolveInside(roots.scratch, path), skill: false };
	const name = m[1]!;
	const rel = m[2] ?? "";
	if (!SKILL_NAME.test(name)) throw new Error(`Invalid skill name in ${path}`);
	const skillDir = join(roots.skills, name);
	const st = await lstat(skillDir).catch(() => undefined);
	if (!st?.isDirectory()) throw new Error(`No such skill: ${name}`);
	return { abs: await resolveInside(skillDir, rel === "" ? "." : rel), skill: true };
}

function pageText(text: string, offset: number, limit: number): string {
	const lines = text.split("\n");
	const start = Math.max(1, offset);
	if (start > lines.length) return `[The file has ${lines.length} lines; offset ${start} is past the end]`;
	const out: string[] = [];
	let bytes = 0;
	let end = start - 1;
	for (let n = start; n <= lines.length && n < start + limit; n++) {
		const line = lines[n - 1]!;
		const size = Buffer.byteLength(line) + 1;
		if (out.length > 0 && bytes + size > READ_MAX_BYTES) break;
		out.push(line);
		bytes += size;
		end = n;
	}
	const body = out.join("\n");
	return end < lines.length ? `${body}\n\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]` : body;
}

const listParams = zod.object({
	path: zod.string().optional().describe("Directory to list: relative to your workspace, or skill://<name>[/<dir>]. Default: the whole workspace."),
});
const readParams = zod.object({
	path: zod.string().describe("File to read: relative to your workspace (e.g. inputs/data.csv), or skill://<name> (the skill's instructions) or skill://<name>/<file>."),
	offset: zod.number().int().min(1).optional().describe("First line to read (1-based)."),
	limit: zod.number().int().min(1).max(10_000).optional().describe(`Number of lines to read (default ${READ_DEFAULT_LINES}).`),
});
const writeParams = zod.object({
	path: zod.string().describe("File to create or overwrite, relative to your workspace. Files under outputs/ are sent to the user."),
	content: zod.string().describe("The complete text content of the file."),
});

async function recorded<T>(tool: string, path: string | undefined, fn: () => Promise<T>): Promise<T> {
	try {
		const result = await fn();
		calls.push({ tool, path, ok: true });
		return result;
	} catch (err) {
		calls.push({ tool, path, ok: false, error: (err as Error).message });
		throw err;
	}
}

export function createAskTools(roots: ToolRoots): CustomTool[] {
	const list: CustomTool<typeof listParams> = {
		name: "list_files",
		label: "List Files",
		description: "List the files in your workspace (recursively) with their sizes, or the files of a skill (skill://<name>).",
		parameters: listParams,
		approval: "read",
		loadMode: "essential",
		execute: (_id, params) =>
			recorded("list_files", params.path, async () => {
				const { abs: dir } = await resolveToolPath(roots, params.path ?? ".");
				const base = params.path && SKILL_URI.test(params.path) ? dir : roots.scratch;
				const lines: string[] = [];
				async function walk(current: string): Promise<void> {
					for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
						if (lines.length >= LIST_MAX_ENTRIES) return;
						const path = join(current, entry.name);
						const rel = relative(base, path).split(sep).join("/");
						if (entry.isDirectory()) {
							lines.push(`${rel}/`);
							await walk(path);
						} else if (entry.isFile()) {
							lines.push(`${rel} (${(await lstat(path)).size} bytes)`);
						}
					}
				}
				await walk(dir);
				return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }], details: { entries: lines.length } };
			}),
	};
	const read: CustomTool<typeof readParams> = {
		name: "read_file",
		label: "Read File",
		description: `Read a text file from your workspace, or a skill's files (skill://<name> for its instructions). Returned in pages of up to ${READ_DEFAULT_LINES} lines (use offset and limit to continue).`,
		parameters: readParams,
		approval: "read",
		loadMode: "essential",
		// AGT-30: omp lists the skills in the system prompt only when an active tool declares this (system-prompt.ts:927).
		readsSkillUris: true,
		execute: (_id, params) =>
			recorded("read_file", params.path, async () => {
				let { abs, skill } = await resolveToolPath(roots, params.path);
				let stat = await lstat(abs).catch(() => undefined);
				// skill://<name> (or skill://<name>/) is the folder; read_file serves its SKILL.md.
				if (skill && stat?.isDirectory()) {
					abs = await resolveInside(abs, "SKILL.md");
					stat = await lstat(abs).catch(() => undefined);
				}
				if (!stat) throw new Error(`No such file: ${params.path}`);
				if (!stat.isFile()) throw new Error(`${params.path} is not a file; use list_files`);
				const bytes = await readFile(abs);
				if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${params.path} is a binary file that cannot be read as text`);
				return { content: [{ type: "text", text: pageText(bytes.toString("utf8"), params.offset ?? 1, params.limit ?? READ_DEFAULT_LINES) }], details: { bytes: stat.size } };
			}),
	};
	const write: CustomTool<typeof writeParams> = {
		name: "write_file",
		label: "Write File",
		description: "Create or overwrite a text file in your workspace. Files under outputs/ are sent back to the user.",
		parameters: writeParams,
		approval: "write",
		loadMode: "essential",
		execute: (_id, params) =>
			recorded("write_file", params.path, async () => {
				if (SKILL_URI.test(params.path)) throw new Error("skills are read-only");
				const abs = await resolveInside(roots.scratch, params.path);
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, params.content);
				return { content: [{ type: "text", text: `Wrote ${params.path}` }], details: {} };
			}),
	};
	return [list, read, write] as CustomTool[];
}
