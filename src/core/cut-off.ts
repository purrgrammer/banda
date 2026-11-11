import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Why a run whose reply was cut off mid tool call failed, in the daemon's words. */
export const CUT_OFF =
	"the reply reached the model's length limit in the middle of a tool call, so that call did not run";

/**
 * Whether a reply stopped at the model's length limit with a tool call in it. pi-durable takes such a reply as the run's
 * answer and never runs the call, so the run did not do what it set out to: it failed, and is said so.
 */
export const cutOff = (message: AssistantMessage): boolean =>
	message.stopReason === "length" && message.content.some((part) => part.type === "toolCall");
