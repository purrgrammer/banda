/**
 * The chat as the owner reads it (DESIGN.md "The app"): derived from the transcript's items, the open asks and
 * the live state, never a second log. The owner's words and the companion's messages (each `message_user` call), a
 * question or an approval as a card, a notice, and one line for work in progress. The model's notes, its thinking, its
 * tool calls and results, and what agents say to each other are never segments: they are the raw transcript's.
 *
 * Pure, so it is unit-tested beside the server's tests; it imports types alone.
 */
import type { TroubleData } from "../../../src/core/routines.ts";
import type { WatchTroubleData } from "../../../src/core/watches.ts";
import type { Answer, Ask, Item, PermissionScope, Queued, RunningTool, ShownWait } from "../../../src/server/api.ts";
import { routineTitle } from "../app/titles.ts";
import { permissionWhen } from "./permissions.ts";
import { SEGMENTERS } from "./segments/index.ts";
import type { AreaSegment, ViewContext } from "./segments/types.ts";

type Question = Extract<Ask, { type: "question" }>;
type Approval = Extract<Ask, { type: "approval" }>;

/** A file a message carries: the owner's by blob, the companion's by the call that sent it and its place. */
export type SegmentFile =
	| { readonly kind: "blob"; readonly name: string; readonly sha: string; readonly image: boolean }
	| {
			readonly kind: "sent";
			readonly name: string;
			readonly call: string;
			readonly n: number;
			readonly image: boolean;
			/** Its message was delivered: until then the daemon may not hold its bytes yet. */
			readonly ready: boolean;
	  }
	| { readonly kind: "item"; readonly name: string; readonly item: number; readonly n: number; readonly image: true };

/** How an ask ended, in words, and its raw outcome. */
export type Ended = {
	readonly outcome: "answered" | "dismissed" | "expired" | "cancelled";
	readonly answer?: Answer;
	/** A typed answer appears as the owner's message beneath the question. */
	readonly inChat?: boolean;
	/** What was picked or answered, or why there was no answer, as the card says it. */
	readonly said: string;
};

/** What the chat shows, part by part: the daemon's kinds here, and each area's own (`segments/`). */
export type Segment = CoreSegment | AreaSegment;

type CoreSegment =
	| {
			readonly kind: "owner";
			readonly key: string;
			readonly text: string;
			readonly files: readonly SegmentFile[];
			readonly at?: number;
			/** Sent while a run works and waiting in its queue: not yet in the transcript. */
			readonly queued?: true;
	  }
	| {
			readonly kind: "companion";
			readonly key: string;
			readonly text: string;
			readonly files: readonly SegmentFile[];
			/** It could not be delivered (or was never sent): shown with a quiet note. */
			readonly undelivered: boolean;
			/** Explicit refs, never model-authored card content. */
			readonly objects?: readonly string[];

			/** It shows the companion's browser, live. */
			readonly view?: "browser";
			readonly at?: number;
	  }
	| {
			readonly kind: "question";
			readonly key: string;
			readonly ask: Question;
			/** Open: the ask's id, which answers it. */
			readonly open?: { readonly wait: string; readonly deadline: number };
			readonly ended?: Ended;
	  }
	| {
			readonly kind: "approval";
			readonly key: string;
			/** The tool call that asked, when the transcript names it. */
			readonly call?: string;
			readonly ask: Approval;
			/** What it would run, in words, as the daemon labels it. */
			readonly label: string;
			/** Its arguments as a labelled list, never JSON. */
			readonly args: readonly (readonly [string, string])[];
			readonly open?: { readonly wait: string; readonly deadline: number };
			readonly ended?: Ended;
	  }
	/**
	 * A notice: something went wrong. One about a routine names it, as one about a watch unable to look for an hour does
	 * (`watch`); a tap opens it in the agent's panel.
	 */
	| {
			readonly kind: "notice";
			readonly key: string;
			readonly text: string;
			readonly routine?: string;
			readonly watch?: string;
			readonly at?: number;
	  }
	| {
			readonly kind: "skill";
			readonly key: string;
			readonly name: string;
			readonly by: "agent" | "owner";
			readonly at?: number;
	  }
	/** An effect ran without asking, within a permission: what ran, in the daemon's words, and for how long it is allowed. */
	| {
			readonly kind: "effect";
			readonly key: string;
			readonly label: string;
			readonly permission: { readonly scope: PermissionScope["scope"]; readonly until?: number };
	  }
	/** Owner-review proposal; acceptance is the only thing that changes a definition or creates a group. */
	| {
			readonly kind: "proposal";
			readonly key: string;
			readonly proposal: Extract<Item, { role: "proposal" }>["proposal"];
			readonly state: "pending" | "accepted" | "declined";
	  }
	/** A message another agent sent to this direct chat, as an attributed feed entry. */
	| {
			readonly kind: "agentMessage";
			readonly key: string;
			readonly from: string;
			readonly text: string;
			readonly at?: number;
	  }
	/**
	 * A routine's event: it woke its agent (the owner's own Run now, when `owner`), and the agent replied or the run
	 * failed; a quiet run draws none (`quietRuns`). `text` is its line's words.
	 */
	| {
			readonly kind: "wake";
			readonly key: string;
			readonly text: string;
			readonly routine?: string;
			readonly owner?: true;
			readonly at?: number;
	  }
	/**
	 * A followed object changed (DESIGN.md "Watches"): the line's words, the watch, the object (its key draws its card
	 * beneath), the changes; `tell` when the chat was only told and no run followed; `ended` on the watch's last wake.
	 */
	| {
			readonly kind: "watch";
			readonly key: string;
			readonly text: string;
			readonly watch: string;
			readonly object: Extract<Item, { role: "watch" }>["object"];
			readonly changes: readonly string[];
			readonly tell?: true;
			readonly ended?: string;
			readonly at: number;
	  }
	| { readonly kind: "working"; readonly key: "working"; readonly text: string };

/**
 * The live state of a chat: whether it runs, its tool calls running, whether it is thinking now, and the owner's
 * messages waiting in its queue.
 */
export type Live = {
	readonly busy: boolean;
	readonly running: readonly Pick<RunningTool, "call" | "doing">[];
	readonly thinking: boolean;
	readonly queued?: readonly Queued[];
};

export const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** The same files beside the owner's words in Chat and Transcript. */
export function userFiles(item: Extract<Item, { role: "user" }>): SegmentFile[] {
	return [
		...(item.files ?? []).map(
			(file): SegmentFile => ({ kind: "blob", name: file.name, sha: file.sha, image: IMAGE.test(file.name) }),
		),
		// Images pasted without a file are fetched by transcript entry.
		...((item.files ?? []).some((file) => IMAGE.test(file.name))
			? []
			: Array.from(
					{ length: item.images ?? 0 },
					(_, n): SegmentFile => ({ kind: "item", name: `image ${n + 1}`, item: item.id, n, image: true }),
				)),
	];
}

/** A box path's last part, as the daemon names a sent file. */
export function fileName(path: string): string {
	const base = path.split(/[/\\]/).at(-1) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
	const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "_").trim();
	return clean === "" || clean === "." || clean === ".." ? "file" : clean.slice(0, 120);
}

/** An answer in words: text as it is, picks joined, a form's values by field. */
export function answerWords(answer: Answer): string {
	if (typeof answer === "string") return answer;
	if (Array.isArray(answer)) return answer.join(", ");
	return Object.entries(answer)
		.map(([field, value]) => `${field}: ${typeof value === "boolean" ? (value ? "yes" : "no") : value}`)
		.join(" · ");
}

function ended(ask: Ask, item: Extract<Item, { role: "wait" }>): Ended {
	const base = { outcome: item.outcome, ...(item.answer === undefined ? {} : { answer: item.answer }) };
	if (item.outcome === "expired")
		return { ...base, said: ask.type === "approval" ? "No answer in time; it did not run" : "No answer in time" };
	if (item.outcome === "dismissed") return { ...base, said: "Dismissed" };
	if (item.outcome === "cancelled")
		return {
			...base,
			said: item.answer === undefined ? "Stopped before an answer" : "Stopped before your answer was used",
		};
	if (item.message !== undefined && ask.type === "question") return { ...base, said: "Answered below", inChat: true };
	if (ask.type === "approval") {
		const yes = item.answer === "approve";
		if (ask.interrupted === true) return { ...base, said: yes ? "Ran again" : "Skipped" };
		if (!yes) return { ...base, said: "Declined" };
		const edited = item.edited === undefined ? "Approved" : "Approved as you edited it";
		const permitted = item.permitted === undefined ? "" : `, and allowed ${permissionWhen(item.permitted)}`;
		return { ...base, said: `${edited}${permitted}` };
	}
	return { ...base, said: item.answer === undefined ? "Answered" : answerWords(item.answer) };
}

/** A value of an approval's arguments as text: never JSON, nested values flattened under their keys. */
function flatten(prefix: string, value: unknown, into: [string, string][]) {
	const label = prefix.replace(/[_-]+/g, " ");
	if (value === null || value === undefined) into.push([label, "—"]);
	else if (typeof value === "string") into.push([label, value]);
	else if (typeof value === "number" || typeof value === "boolean")
		into.push([label, typeof value === "boolean" ? (value ? "yes" : "no") : String(value)]);
	else if (Array.isArray(value)) {
		if (value.every((v) => typeof v !== "object" || v === null))
			into.push([label, value.map((v) => (v === null ? "—" : String(v))).join(", ")]);
		else for (const [i, v] of value.entries()) flatten(`${prefix} ${i + 1}`, v, into);
	} else for (const [key, v] of Object.entries(value)) flatten(prefix === "" ? key : `${prefix} › ${key}`, v, into);
}

export function argList(args: { readonly [key: string]: unknown }): [string, string][] {
	const into: [string, string][] = [];
	// an argument named with a leading `_` is the daemon's handle on what the rest shows (a held request's ticket)
	for (const [key, value] of Object.entries(args)) if (!key.startsWith("_")) flatten(key, value, into);
	return into;
}

/**
 * `*` on an `ask_hosts` draft is every destination: the card flags that line in red, so the owner approves it knowing
 * what it opens (or trims it out). Read from the current text, so an edit that removes `*` clears the flag.
 */
export function wildcardWarning(tool: string, hosts: string): string | undefined {
	if (tool !== "ask_hosts") return undefined;
	if (!hosts.split("\n").some((line) => line.trim() === "*")) return undefined;
	return "* is every host: anything this agent sends, to any destination, would go straight through.";
}

/**
 * How an approval's draft is laid out: the text arguments the owner may edit, the rest as facts it leads with, and the
 * arguments that are the effect in full (a request's headers, its raw body) as rows behind a disclosure.
 */
export function draftParts(ask: Extract<Ask, { type: "approval" }>): {
	readonly fields: string[];
	readonly rest: { [key: string]: unknown };
	readonly details: [string, string][];
} {
	const fields = (ask.editable ?? []).filter((name) => typeof ask.args[name] === "string");
	const full = (ask.details ?? []).filter((name) => !fields.includes(name) && ask.args[name] !== undefined);
	return {
		fields,
		rest: Object.fromEntries(
			Object.entries(ask.args).filter(([name]) => !fields.includes(name) && !full.includes(name)),
		),
		details: argList(Object.fromEntries(full.map((name) => [name, ask.args[name]]))),
	};
}

/**
 * A failed request in the owner's words: a connection that dropped says so, whatever the provider called it; a key the
 * provider refused or a limit it hit says what to do; any other failure is the provider's own message (a refused
 * model), taken out of the JSON a provider wraps it in, and cut to a sentence or two, never a raw body.
 */
export function failureWords(error: string): string {
	if (/stream ended|terminated|socket|ECONNRESET|ETIMEDOUT|network|fetch failed|timed? ?out/i.test(error))
		return "the connection to the model dropped.";
	if (
		/API[_ ]?KEY[_ ]?INVALID|api key not valid|invalid (x-)?api[- ]key|incorrect api key|\b401\b|unauthori[sz]ed/i.test(
			error,
		)
	)
		return "the model provider refused its key. Sign in again or change the key in Settings.";
	if (/\b429\b|rate.?limit|quota|RESOURCE_EXHAUSTED|overloaded/i.test(error))
		return "the model provider is busy or out of quota. Try again in a moment.";
	if (!/^\s*[{[]/.test(error)) return error;
	const said = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(error)?.[1];
	const words =
		said === undefined ? "the model provider sent an error it did not explain." : said.replace(/\\(.)/g, "$1");
	return words.length > 200 ? `${words.slice(0, 199)}…` : words;
}

/**
 * What "Try again" follows (DESIGN.md "The chat"): a reply that failed, a message that was not delivered, or a run that
 * ended without answering the owner; the newest segment, when it is one of those, and none once anything came after.
 */
export function tryAgainAfter(segments: readonly Segment[]): string | undefined {
	const newest = segments.filter((segment) => segment.kind !== "working").at(-1);
	if (newest?.kind === "notice" && (newest.key.endsWith(":error") || newest.key.endsWith(":unanswered")))
		return newest.key;
	if (newest?.kind === "companion" && newest.undelivered) return newest.key;
	return undefined;
}

/**
 * A run that ended without a word to the owner: their message is the newest thing shown, nothing runs or waits, and the
 * agent worked after it (its turn ran, and left only notes, which are never the owner's to read). The daemon nudges
 * such a run before it ends (`core/unanswered.ts`); this is what is left when that did not help.
 */
function unansweredAfter(items: readonly Item[], segments: readonly Segment[], live: Live, waiting: boolean) {
	if (live.busy || waiting || (live.queued ?? []).length > 0) return undefined;
	const newest = segments.at(-1);
	if (newest?.kind !== "owner" || newest.queued === true) return undefined;
	let owner = items.length - 1;
	while (owner >= 0 && items[owner]?.role !== "user") owner--;
	const last = items.at(-1);
	const told = items[owner];
	// an edit of an artifact is told to the chat as the owner's words, and needs no answer
	if (told?.role !== "user" || told.artifact !== undefined || last === undefined || last.role === "user")
		return undefined;
	const after = items.slice(owner + 1);
	// stopped by the owner: the chat says so itself
	const stopped = after.some(
		(item) =>
			(item.role === "assistant" && item.error !== undefined) ||
			(item.role === "tool" && (item.notes ?? []).some((note) => (note as { code?: string }).code === "aborted")),
	);
	// a message_user call that went through (a reaction alone included) answered them; a call with no result has not
	// ended
	const ended = new Map(after.flatMap((item) => (item.role === "tool" ? [[item.call, !item.error] as const] : [])));
	const calls = after.flatMap((item) => (item.role === "assistant" ? (item.calls ?? []) : []));
	if (calls.some((call) => !ended.has(call.id) || (call.name === "message_user" && ended.get(call.id) === true)))
		return undefined;
	// the newest shown must be that message itself, not an answer typed to a question after it
	if (stopped || newest.key !== `${told.id}` || !after.some((item) => item.role === "assistant")) return undefined;
	return told.id;
}

/** Whether a message_user result says its message never reached the owner. */

const undeliveredResult = (result: Extract<Item, { role: "tool" }> | undefined) =>
	result?.error === true && /^(Not sent|Not delivered|The message was cancelled)/.test(result.text);

/** The line for work in progress: the running call's own, else thinking, else working; none while it waits on the owner. */
export function workingLine(live: Live, waiting: boolean): string | undefined {
	if (!live.busy || waiting) return undefined;
	const doing = [...live.running].reverse().find((tool) => tool.doing !== undefined)?.doing;
	if (doing !== undefined) return `${doing}…`;
	return live.thinking ? "thinking…" : "working…";
}

export function view(
	items: readonly Item[],
	waits: readonly ShownWait[],
	live: Live,
	context: ViewContext = {},
): Segment[] {
	const delivered = new Set(
		items.flatMap((item) =>
			item.role === "user" && item.origin?.peer === "owner" && item.message !== undefined
				? [`${item.origin.gateway}:${item.message}`]
				: [],
		),
	);
	const results = new Map<string, Extract<Item, { role: "tool" }>>();
	// Candidate receipts identify immutable occurrences, even when a page has no assistant entry yet.
	const candidates = new Map<string, Extract<Item, { role: "tool" }>>();
	const endedByCall = new Map<string, Extract<Item, { role: "wait" }>[]>();
	const calls = new Set<string>();
	for (const item of items) {
		if (item.role === "tool") {
			results.set(item.call, item);
			if (item.name === "message_user" && !item.error && item.receipt?.kind === "avatar")
				candidates.set(`${item.receipt.assistant}:${item.receipt.index}`, item);
		}
		if (item.role === "wait" && item.call !== undefined)
			endedByCall.set(item.call, [...(endedByCall.get(item.call) ?? []), item]);
		if (item.role === "assistant") for (const call of item.calls ?? []) calls.add(call.id);
	}
	const openByCall = new Map<string, ShownWait[]>();
	for (const wait of waits)
		if (wait.call !== undefined && calls.has(wait.call))
			openByCall.set(wait.call, [...(openByCall.get(wait.call) ?? []), wait]);

	const asks = (key: string, call: string): Segment[] => {
		const all = [
			...(endedByCall.get(call) ?? []).map((item) => ({ ask: item.ask, item, label: item.label })),
			...(openByCall.get(call) ?? []).map((wait) => ({ ask: wait.ask, wait, label: wait.label })),
		];
		return all.map((one, i) => askSegment(`${key}:ask:${i}`, one, call));
	};

	const segments: Segment[] = [];
	// An owner's /name load is recorded before the message that asked for it (the model reads it first); the feed shows
	// it after that message, as the owner wrote it: held until the message is placed.
	const placed = new Set<string>();
	const held = new Map<string, Segment[]>();
	for (const item of items) {
		if (item.role === "user") {
			const files = userFiles(item);
			segments.push({
				kind: "owner",
				key: `${item.id}`,
				text: item.text,
				files,
				...(item.at === undefined ? {} : { at: item.at }),
			});
			if (item.origin?.peer === "owner" && item.message !== undefined) {
				const invoked = `${item.origin.gateway}:${item.message}`;
				placed.add(invoked);
				segments.push(...(held.get(invoked) ?? []));
				held.delete(invoked);
			}
		} else if (item.role === "assistant") {
			if (item.error !== undefined)
				segments.push(
					item.error === "interrupted"
						? { kind: "notice", key: `${item.id}:stopped`, text: "Stopped" }
						: { kind: "notice", key: `${item.id}:error`, text: `Couldn't get a reply: ${failureWords(item.error)}` },
				);
			for (const [index, call] of (item.calls ?? []).entries()) {
				const key = `${item.id}:${call.id}`;
				if (call.name !== "message_user") {
					const at = { ...withResult(results.get(call.id)), asks: () => asks(key, call.id), context };
					let own: Segment[] | undefined;
					for (const segmenter of SEGMENTERS) {
						own = segmenter.call?.(call, key, at);
						if (own !== undefined) break;
					}
					segments.push(...(own ?? at.asks()));
					continue;
				}
				const args = call.args as {
					text?: unknown;
					files?: unknown;
					question?: unknown;
					view?: unknown;
					objects?: unknown;
				};
				const text = typeof args.text === "string" ? args.text.trim() : "";
				const paths = Array.isArray(args.files) ? args.files.filter((p): p is string => typeof p === "string") : [];
				const live = args.view === "browser";
				const objects = Array.isArray(args.objects)
					? args.objects.filter((ref): ref is string => typeof ref === "string").slice(0, 3)
					: [];
				// refused by the daemon (talking in circles, a file too big…): it was never the owner's to read; the agent
				// was told why
				const refused = /^Not sent/.test(results.get(call.id)?.text ?? "") && results.get(call.id)?.error === true;
				if (!refused && (text !== "" || paths.length > 0 || live || objects.length > 0))
					segments.push({
						kind: "companion",
						key,
						text,
						files: paths.map(
							(path, n): SegmentFile => ({
								kind: "sent",
								name: fileName(path),
								call: call.id,
								n,
								image: IMAGE.test(path),
								ready: results.has(call.id) && !undeliveredResult(results.get(call.id)),
							}),
						),
						undelivered: undeliveredResult(results.get(call.id)),
						...(objects.length === 0 ? {} : { objects }),

						...(live ? { view: "browser" as const } : {}),
						...(item.at === undefined ? {} : { at: item.at }),
					});
				for (const segmenter of SEGMENTERS)
					segments.push(
						...(segmenter.message?.(call, key, {
							...withResult(candidates.get(`${item.id}:${index}`) ?? results.get(call.id)),
							occurrence: { assistant: item.id, index },
						}) ?? []),
					);
				const found = asks(key, call.id);
				if (found.length > 0) segments.push(...found);
				else if (typeof args.question === "string" && !undeliveredResult(results.get(call.id))) {
					// asked, and not yet open (being sent) or never opened: shown, without controls
					const question: Question = {
						type: "question",
						question: args.question,
						...(Array.isArray((args as { options?: unknown }).options)
							? { options: (args as { options: string[] }).options }
							: {}),
					};
					segments.push({ kind: "question", key: `${key}:ask`, ask: question });
				}
			}
		} else if (
			item.role === "tool" &&
			item.receipt?.kind === "skill" &&
			!item.error &&
			(item.receipt.invocation === undefined ||
				delivered.has(`${item.receipt.invocation.gateway}:${item.receipt.invocation.message}`))
		) {
			const line: Segment = {
				kind: "skill",
				key: `${item.id}`,
				name: item.receipt.name,
				by: item.receipt.by,
				...(item.at === undefined ? {} : { at: item.at }),
			};
			const invoked =
				item.receipt.invocation === undefined
					? undefined
					: `${item.receipt.invocation.gateway}:${item.receipt.invocation.message}`;
			if (invoked === undefined || placed.has(invoked)) segments.push(line);
			else held.set(invoked, [...(held.get(invoked) ?? []), line]);
		} else if (item.role === "wait") {
			if (item.call === undefined || !calls.has(item.call))
				segments.push(askSegment(`${item.id}`, { ask: item.ask, item, label: item.label }));
			if (item.message !== undefined && item.ask.type === "question" && typeof item.answer === "string")
				segments.push({ kind: "owner", key: `answer:${item.id}`, text: item.answer, files: [], at: item.at });
		} else if (item.role === "proposal")
			segments.push({ kind: "proposal", key: `${item.id}`, proposal: item.proposal, state: item.proposal.state });
		else if (item.role === "proposalResult") {
			let at = segments.length - 1;
			while (at >= 0) {
				const proposal = segments[at];
				if (proposal?.kind === "proposal" && proposal.proposal.id === item.proposal) {
					segments[at] = { ...proposal, state: item.state };
					break;
				}
				at--;
			}
		} else if (item.role === "agentMessage")
			segments.push({
				kind: "agentMessage",
				key: `${item.id}`,
				from: item.from,
				text: item.text,
				...(item.at === undefined ? {} : { at: item.at }),
			});
		else if (item.role === "notice")
			segments.push({
				kind: "notice",
				key: `${item.id}`,
				text:
					item.routine !== undefined
						? troubleWords(item.routine)
						: item.watch !== undefined
							? watchTroubleWords(item.watch)
							: item.text,
				...(item.routine === undefined ? {} : { routine: item.routine.routine }),
				...(item.watch === undefined ? {} : { watch: item.watch.watch }),
				...(item.at === undefined ? {} : { at: item.at }),
			});
		else if (item.role === "effect")
			segments.push({ kind: "effect", key: `${item.id}`, label: item.label, permission: item.permission });
		else if (item.role === "wake")
			segments.push({
				kind: "wake",
				key: `${item.id}`,
				text:
					item.owner === true
						? `You ran ${routineTitle(item.routine, item.text)}`
						: `${routineTitle(item.routine, item.text)} ran`,
				routine: item.routine,
				...(item.owner === true ? { owner: true as const } : {}),
				...(item.at === undefined ? {} : { at: item.at }),
			});
		else if (item.role === "watch")
			segments.push({
				kind: "watch",
				key: `${item.id}`,
				text: watchWords(item),
				watch: item.watch,
				object: item.object,
				changes: item.changes,
				...(item.tell === true ? { tell: true as const } : {}),
				...(item.ended === undefined ? {} : { ended: item.ended }),
				at: item.at,
			});
	}
	// asks whose call is not in the items read so far: still answerable
	for (const wait of waits)
		if (wait.call === undefined || !calls.has(wait.call))
			segments.push(askSegment(`open:${wait.key}`, { ask: wait.ask, wait, label: wait.label }));
	const line = workingLine(live, waits.length > 0);
	if (line !== undefined) segments.push({ kind: "working", key: "working", text: line });
	const unanswered = unansweredAfter(items, segments, live, waits.length > 0);
	if (unanswered !== undefined)
		segments.push({ kind: "notice", key: `${unanswered}:unanswered`, text: "No answer to this" });
	return [
		...quietRuns(
			SEGMENTERS.reduce((all, segmenter) => segmenter.after?.(all, { items, waits, live, context }) ?? all, segments),
		),
		...queuedSegments(items, live.queued ?? []),
	];
}

/** What a run shows that is not the agent saying anything: its browsing and reading, and the working line. */
const QUIET: ReadonlySet<string> = new Set(["browsed", "read", "working"]);

/**
 * A routine's quiet runs leave no trace (DESIGN.md "Routines"): a wake whose run, up to the owner's next words or the
 * next wake, shows nothing but its browsing and reading draws neither its line nor those. A run that said something,
 * asked, or failed keeps its line; one that failed as a routine's trouble says so once, so the reply's own failure
 * line goes. The working line stays wherever it is.
 */
export function quietRuns(segments: readonly Segment[]): Segment[] {
	const out: Segment[] = [];
	let i = 0;
	while (i < segments.length) {
		const segment = segments[i] as Segment;
		if (segment.kind !== "wake") {
			out.push(segment);
			i++;
			continue;
		}
		let end = i + 1;
		while (
			end < segments.length &&
			!["owner", "owner-message", "wake", "watch"].includes((segments[end] as Segment).kind)
		)
			end++;
		const run = segments.slice(i + 1, end);
		const said = run.some((each) => !QUIET.has(each.kind));
		const trouble = run.some((each) => each.kind === "notice" && each.routine !== undefined);
		if (said)
			out.push(segment, ...run.filter((each) => !(trouble && each.kind === "notice" && each.key.endsWith(":error"))));
		else out.push(...run.filter((each) => each.kind === "working"));
		i = end;
	}
	return out;
}

/**
 * A watch's line, in the owner's words: the object and what changed ("acme/banda #142 · ana approved, lint failed"),
 * and what ended it ("… · done: merged").
 */
export function watchWords(item: Pick<Extract<Item, { role: "watch" }>, "object" | "changes" | "ended">): string {
	const changes = item.changes.filter((change) => change !== item.ended);
	const words = [item.object.name, ...(changes.length === 0 ? [] : [changes.join(", ")])];
	if (item.ended !== undefined) words.push(`done: ${item.ended}`);
	return words.join(" · ");
}

/** A watch unable to look for an hour, in the owner's words: what it follows, where, since when, and why. */
export function watchTroubleWords(data: WatchTroubleData): string {
	const time = new Date(data.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return `${data.name} · can't reach ${data.service ?? "it"} since ${time} · ${data.why}`;
}

/** A routine in trouble, in the owner's words: which, and what went wrong. */
export function troubleWords(data: TroubleData): string {
	const title = routineTitle(data.routine, data.description);
	if (data.trouble === "failed") return `${title} failed: ${failureWords(data.why)}`;
	if (data.trouble === "stalled") {
		const time = new Date(data.due).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		return `${title} skipped its ${time} run: the last one is still going`;
	}
	return `${title} paused: it ran ${data.runsADay} times today, the most it may. Resume it in the panel`;
}

/**
 * The owner's queued messages, last, as their own words dimmed. One the transcript already holds (its entry came
 * before the queue said it left) is shown once, as the entry.
 */
function queuedSegments(items: readonly Item[], queued: readonly Queued[]): Segment[] {
	const placed = new Set(
		items.flatMap((item) => (item.role === "user" && item.message !== undefined ? [item.message] : [])),
	);
	return queued.flatMap((one): Segment[] =>
		one.message !== undefined && placed.has(one.message)
			? []
			: [
					{
						kind: "owner",
						key: `queued:${one.id}`,
						text: one.text,
						// pasted images show once the entry holds them; files show by their blobs now
						files: (one.files ?? []).map(
							(file): SegmentFile => ({ kind: "blob", name: file.name, sha: file.sha, image: IMAGE.test(file.name) }),
						),
						queued: true,
					},
				],
	);
}

const withResult = (result: Extract<Item, { role: "tool" }> | undefined) => (result === undefined ? {} : { result });

function askSegment(
	key: string,
	one: { ask: Ask; label?: string | undefined; item?: Extract<Item, { role: "wait" }>; wait?: ShownWait },
	call?: string,
): Segment {
	const open = one.wait === undefined ? {} : { open: { wait: one.wait.key, deadline: one.wait.deadline } };
	const done = one.item === undefined ? {} : { ended: ended(one.ask, one.item) };
	if (one.ask.type === "question") return { kind: "question", key, ask: one.ask, ...open, ...done };
	return {
		kind: "approval",
		key,
		...(call === undefined ? {} : { call }),
		ask: one.item?.edited === undefined ? one.ask : { ...one.ask, args: one.item.edited },
		label: one.label ?? one.ask.label ?? "this",
		// what ran: the draft as the owner edited it
		args: argList(one.item?.edited ?? one.ask.args),
		...open,
		...done,
	};
}

/** Every string a segment shows the owner: what the property checks never carries the raw transcript's. */
export function shown(segment: Segment): string[] {
	if (!isCore(segment)) {
		for (const segmenter of SEGMENTERS) {
			const own = segmenter.shown?.(segment);
			if (own !== undefined) return [...own];
		}
		return [];
	}
	switch (segment.kind) {
		case "owner":
		case "companion":
			return [segment.text, ...segment.files.map((file) => file.name)];
		case "question":
			return [
				segment.ask.question,
				...(segment.ask.options ?? []),
				...(segment.ask.fields ?? []).flatMap((field) => [field.name, field.hint ?? "", ...(field.options ?? [])]),
				segment.ended?.said ?? "",
			];
		case "approval":
			return [segment.label, ...segment.args.flat(), segment.ended?.said ?? ""];
		case "effect":
			return [segment.label];
		case "skill":
			return [`Loaded /${segment.name}`];
		case "proposal":
			return [
				segment.proposal.kind,
				segment.proposal.kind === "agentChange" ? segment.proposal.agent : segment.proposal.name,
			];
		case "agentMessage":
			return [segment.from, segment.text];
		case "notice":
		case "wake":
		case "working":
			return [segment.text];
		case "watch":
			return [segment.text, segment.object.name, ...segment.changes];
	}
}

const CORE_KINDS: ReadonlySet<string> = new Set<CoreSegment["kind"]>([
	"owner",
	"companion",
	"question",
	"approval",
	"notice",
	"skill",
	"effect",
	"proposal",
	"agentMessage",
	"wake",
	"watch",
	"working",
]);

/** Whether a segment is one of the daemon's kinds, not an area's. */
export const isCore = (segment: Segment): segment is CoreSegment => CORE_KINDS.has(segment.kind);
