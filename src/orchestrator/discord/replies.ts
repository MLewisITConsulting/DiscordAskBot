import { errorMessage, log } from "../../shared/log";
import type { DiscordSurface, MsgRef } from "./surface";

/** RUN-15: the reply to a steering message the run ended before reading. */
export const NOT_DELIVERED = "Not delivered: the run ended before it could read this.";

/**
 * RUN-15, DSC-24: acknowledges a steering message as `steer` settles it: ⏳ while the run cannot take it yet, then 👀
 * once the run received it, or a reply when the run ended first. Discord failures are only logged.
 */
export async function acknowledgeSteer(
	surface: DiscordSurface,
	message: MsgRef,
	steer: (onQueued: () => void) => Promise<"delivered" | "ended">,
): Promise<"delivered" | "ended"> {
	let queued: Promise<void> | undefined;
	const quiet = (err: unknown) => log("debug", "steer acknowledgement failed", { channel: message.channelId, error: errorMessage(err) });
	const outcome = await steer(() => {
		queued ??= surface.react(message, "⏳").catch(quiet);
	});
	if (queued) await queued.then(() => surface.unreact(message, "⏳")).catch(quiet);
	if (outcome === "delivered") await surface.react(message, "👀").catch(quiet);
	else await surface.reply(message, { content: NOT_DELIVERED }, "high").catch(quiet);
	return outcome;
}
