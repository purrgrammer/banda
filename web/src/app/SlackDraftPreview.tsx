import { BellIcon } from "lucide-react";
import { useId } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { type SlackNames, slackNotifies, slackPlain } from "../../../src/core/slack-text.ts";
import { slackWhen } from "../chat/Object.tsx";

/** A Slack post a draft may be, by the tool's own name. */
export const SLACK_DRAFT = /^slack__post_message$/;

/** A Slack reaction a draft may be, by the tool's own name. */
export const SLACK_REACTION = /^slack__add_reaction$/;

/** Slack's most used emoji by name, drawn as themselves; any other (a team's own among them) is shown by its name. */
const EMOJI: Record<string, string> = {
	white_check_mark: "✅",
	heavy_check_mark: "✔️",
	ballot_box_with_check: "☑️",
	x: "❌",
	eyes: "👀",
	"+1": "👍",
	thumbsup: "👍",
	"-1": "👎",
	thumbsdown: "👎",
	tada: "🎉",
	raised_hands: "🙌",
	clap: "👏",
	pray: "🙏",
	wave: "👋",
	heart: "❤️",
	fire: "🔥",
	rocket: "🚀",
	joy: "😂",
	smile: "😄",
	thinking_face: "🤔",
	warning: "⚠️",
	ok_hand: "👌",
	"100": "💯",
	muscle: "💪",
};

/**
 * A Slack reaction as the owner approves it: the emoji, drawn where it is one of Slack's own, by its name, and which
 * message it goes on, by when it was written; it notifies only that message's author. The message is on the thread's
 * card above, and the draft's words say where.
 */
export function SlackReactionPreview({ args }: { args: Record<string, unknown> }) {
	const name = typeof args.name === "string" ? args.name.replace(/^:|:$/g, "") : "";
	const glyph = EMOJI[name.split("::")[0] ?? ""];
	const seconds = typeof args.ts === "string" ? Number(args.ts) : Number.NaN;
	const when = Number.isFinite(seconds) ? slackWhen(new Date(seconds * 1000).toISOString()) : "";
	const where = typeof args._channel_name === "string" && args._channel_name !== "" ? ` in #${args._channel_name}` : "";
	return (
		<section
			aria-label="Slack reaction draft"
			className="flex min-w-0 items-start gap-3 rounded-field border border-line-soft bg-paper-2 p-3.5"
			data-slack-reaction={name}
		>
			{glyph === undefined ? null : (
				<span aria-hidden="true" className="shrink-0 text-2xl leading-tight">
					{glyph}
				</span>
			)}
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="text-body font-medium text-ink [overflow-wrap:break-word]">:{name}:</span>
				<span className="text-meta text-ink-2 [overflow-wrap:anywhere]">
					{when === "" ? `On a message${where}` : `On the message from ${when}${where}`}
				</span>
				<span className="flex min-w-0 items-start gap-1.5 text-meta text-ink-2">
					<BellIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					Notifies only the message's author
				</span>
			</span>
		</section>
	);
}

/** The names the daemon read for the mentions in the drafted text, by id. */
function namesOf(args: Record<string, unknown>): SlackNames {
	const known = typeof args._names === "object" && args._names !== null ? (args._names as Record<string, unknown>) : {};
	return (_kind, id) => (typeof known[id] === "string" ? (known[id] as string) : undefined);
}

/**
 * A Slack post as the owner approves it: the text, editable, then how it will read in Slack and who it will notify,
 * from the text as edited. Where it goes is the card above, drawn by the daemon, and the draft's words.
 */
export function SlackDraftPreview({
	args,
	edits,
	readOnly,
	onEdit,
}: {
	args: Record<string, unknown>;
	edits: Record<string, string>;
	readOnly: boolean;
	onEdit: (name: string, value: string) => void;
}) {
	const id = useId();
	const text = edits.text ?? (typeof args.text === "string" ? args.text : "");
	const names = namesOf(args);
	const reads = slackPlain(text, names);
	const notifies = slackNotifies(text, names);
	return (
		<section
			aria-label="Slack message draft"
			className="flex min-w-0 flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-3.5"
		>
			<Field className="min-w-0 gap-1">
				<FieldLabel htmlFor={`${id}-text`}>What will be sent</FieldLabel>
				<Textarea
					id={`${id}-text`}
					aria-label="Slack message"
					value={text}
					readOnly={readOnly}
					className="min-h-24 bg-paper text-body"
					onChange={(event) => onEdit("text", event.target.value)}
				/>
			</Field>
			{reads === text ? null : (
				<div className="flex min-w-0 flex-col gap-1">
					<p className="text-meta text-ink-2">As it will read</p>
					<p className="text-body text-ink whitespace-pre-wrap [overflow-wrap:anywhere]" data-slack-reads="">
						{reads}
					</p>
				</div>
			)}
			<p className="flex min-w-0 items-start gap-1.5 text-meta text-ink-2" data-slack-notifies="">
				<BellIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
				<span className="[overflow-wrap:anywhere]">
					{notifies.length === 0 ? "Notifies no one by name" : `Notifies ${notifies.join(", ")}`}
				</span>
			</p>
		</section>
	);
}
