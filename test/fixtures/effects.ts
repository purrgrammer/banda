/**
 * Demo effect tools for tests and the smoke run (never shipped to the agent: no connection exists yet): `send_message`
 * sends a message to someone (a permission binds the recipient; the owner may edit the text), and `pay` pays someone, on the
 * floor. Each run is told to `ran`, so a test sees what ran and with what.
 */
import { Type } from "@earendil-works/pi-ai";
import type { EffectTool } from "../../src/core/ask.ts";

export type Ran = { readonly tool: string; readonly args: { readonly [key: string]: unknown } };

const sendParameters = Type.Object({ to: Type.String(), text: Type.String() });
const payParameters = Type.Object({ to: Type.String(), amount: Type.String() });

export function demoEffects(
	ran: (run: Ran) => void,
): [EffectTool<typeof sendParameters>, EffectTool<typeof payParameters>] {
	return [
		{
			name: "send_message",
			description: "Send a message to someone on the owner's behalf.",
			parameters: sendParameters,
			effect: "unsafe",
			describe: (args) => `send a message to ${args.to}`,
			editable: ["text"],
			permission: { args: ["to"], what: (args) => `send messages to ${args.to}` },
			run: async (args) => {
				ran({ tool: "send_message", args });
				return { output: [{ type: "text", text: `Sent to ${args.to}.` }] };
			},
		},
		{
			name: "pay",
			description: "Pay someone an amount.",
			parameters: payParameters,
			effect: "unsafe",
			floor: "money",
			describe: (args) => `pay ${args.to} ${args.amount}`,
			run: async (args) => {
				ran({ tool: "pay", args });
				return { output: [{ type: "text", text: `Paid ${args.to} ${args.amount}.` }] };
			},
		},
	];
}
