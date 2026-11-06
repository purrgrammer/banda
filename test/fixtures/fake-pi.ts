/**
 * A scripted stand-in for `pi --mode rpc`, for banda's pi adapter: a prompt `run <cmd>` runs a bash tool, `confirm
 * <title>` opens an extension confirm dialog, `slow` takes a while, anything else is said; a prompt that steers while
 * one runs joins that run, which ends once (agent_end); abort ends it at once. One JSON line per event, as pi's RPC.
 */
import { jsonLines } from "../../src/core/acp.ts";

const out = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
let running = false;
let queued: string[] = [];
let aborted = false;
let wake: (() => void) | undefined;
let n = 0;
const dialogs = new Map<string, (value: { confirmed?: boolean; cancelled?: boolean }) => void>();

async function step(text: string) {
	const [verb = "", ...rest] = text.split(" ");
	if (verb === "run") {
		const id = `t${++n}`;
		out({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: rest.join(" ") } });
		out({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
	} else if (verb === "confirm") {
		const id = `ui${++n}`;
		const answer = await new Promise<{ confirmed?: boolean }>((resolve) => {
			dialogs.set(id, resolve);
			out({ type: "extension_ui_request", id, method: "confirm", title: rest.join(" "), message: "" });
		});
		out({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: answer.confirmed ? "confirmed" : "declined" },
		});
	} else if (verb === "slow") {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 400);
			wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	} else out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
}

async function run(first: string) {
	running = true;
	aborted = false;
	out({ type: "agent_start" });
	queued = [first];
	while (queued.length > 0 && !aborted) await step(queued.shift() ?? "");
	queued = [];
	running = false;
	out({ type: "agent_end", messages: [] });
}

process.stdin.on("end", () => process.exit(0));
jsonLines(process.stdin, (line) => {
	const command = JSON.parse(line) as {
		type: string;
		id?: string;
		message?: string;
		streamingBehavior?: string;
		confirmed?: boolean;
		cancelled?: boolean;
	};
	if (command.type === "prompt") {
		out({ type: "response", id: command.id, command: "prompt", success: true });
		if (running) queued.push(command.message ?? "");
		else void run(command.message ?? "");
	} else if (command.type === "abort") {
		aborted = true;
		wake?.();
		out({ type: "response", command: "abort", success: true });
	} else if (command.type === "extension_ui_response") {
		dialogs.get(command.id ?? "")?.(command);
		dialogs.delete(command.id ?? "");
	}
});
