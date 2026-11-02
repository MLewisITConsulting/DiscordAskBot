/** Message texts of an ask turn (ported from DevForge `src/discord/render.ts`). */

const MAX_MESSAGE = 2000;

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
}

export type ProgressState = "running" | "done" | "failed" | "cancelled";

const PROGRESS_STATES: Record<ProgressState, { icon: string; text: string }> = {
	running: { icon: "🛠️", text: "working" },
	done: { icon: "✅", text: "finished" },
	failed: { icon: "❌", text: "failed" },
	cancelled: { icon: "⏹️", text: "cancelled" },
};

/** The live status message of an ask turn (DSC-10); while running, the second line shows what the agent is doing. */
export function progressLine(p: { title: string; state: ProgressState; elapsedMs: number; cost: number; activity: string }): string {
	const { icon, text } = PROGRESS_STATES[p.state];
	const line = `${icon} **${p.title}** · ${text} · ${formatElapsed(p.elapsedMs)} · $${p.cost.toFixed(2)}`;
	return p.state === "running" ? `${line}\n↳ ${p.activity}` : line;
}

/** What the agent is doing, from its latest tool call. */
export function activityText(tool: string | undefined, intent: string | undefined): string {
	if (!tool) return "Thinking…";
	return intent ? `${intent} (\`${tool}\`)` : `Running \`${tool}\``;
}

/** AGT-19: the line an ask turn's answer message carries when the kernel OOM-killed processes during the turn. */
export const OOM_WARNING = "⚠️ The agent ran out of memory during this turn; the answer may be incomplete.";

/** Splits text into ≤max-char chunks on paragraph boundaries; oversize paragraphs are hard-split (DSC-14). */
export function chunkText(text: string, max = MAX_MESSAGE): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const paragraph of text.split(/\n{2,}/)) {
		if (!paragraph.trim()) continue;
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (candidate.length <= max) {
			current = candidate;
			continue;
		}
		if (current) chunks.push(current);
		current = "";
		let rest = paragraph;
		while (rest.length > max) {
			const nl = rest.lastIndexOf("\n", max);
			const cut = nl > 0 ? nl : max;
			chunks.push(rest.slice(0, cut));
			rest = rest.slice(cut).replace(/^\n/, "");
		}
		current = rest;
	}
	if (current) chunks.push(current);
	return chunks;
}
