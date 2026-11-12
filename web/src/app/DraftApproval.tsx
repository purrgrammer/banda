/** One approval view for direct chats and groups: the daemon's verb, account, stored facts and editable bytes. */

import { type ReactNode, useState } from "react";
import { FieldGroup } from "@/components/ui/field";
import { ApprovalCard, type ApprovalState, Details, Facts, HostsWarning } from "../chat/Approval.tsx";
import { EditableText } from "../chat/EditableText.tsx";
import { FileChanges } from "../chat/FileChanges.tsx";
import { type Ask, answerWait } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { argList, draftParts, wildcardWarning } from "../lib/chat.ts";
import { fileChanges } from "../lib/file-changes.ts";
import { scopeOf, scopesOf } from "../lib/permissions.ts";
import { CONTACT_DRAFT, ContactDraftPreview } from "./ContactDraftPreview.tsx";
import { DRIVE_DRAFT, DriveDraftPreview } from "./DriveDraftPreview.tsx";
import { EmailDraftPreview } from "./EmailDraftPreview.tsx";
import { CALENDAR_DRAFT, EventDraftPreview, eventDraftWhat } from "./EventDraftPreview.tsx";
import { ObjectPreviews } from "./Objects.tsx";
import { SLACK_DRAFT, SLACK_REACTION, SlackDraftPreview, SlackReactionPreview } from "./SlackDraftPreview.tsx";

type Props = {
	chat: number;
	agent: { readonly id?: string | undefined; readonly name: string };
	ask: Extract<Ask, { type: "approval" }>;
	label: string;
	wait?: string | undefined;
	state?: ApprovalState | undefined;
	/** The object the draft acts on, drawn already (the specimen's), instead of read from the daemon. */
	drawn?: ReactNode;
	/** Approved as the owner edited it: the draft that ran, which the answered card reads. */
	edited?: { readonly [arg: string]: unknown } | undefined;
};

/** The text arguments that are one line: a title, a commit's title. */
const TITLES = new Set(["title", "commit_title", "subject"]);

/**
 * A text argument as the card names it: a body is what will be sent, or a description beside a title (a pull request,
 * an issue); any other its name in words.
 */
function fieldLabel(name: string, fields: readonly string[]): string {
	if (name === "body") return fields.includes("title") ? "Description" : "What will be sent";
	const words = name.replaceAll("_", " ");
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * What the owner does on a card (the scope ticked, the text edited) is that ask's alone: a card is drawn afresh for
 * each Wait, so another ask in the same place of the feed never starts with the last one's tick.
 */
export function DraftApproval(props: Props) {
	return <Draft key={props.wait ?? "answered"} {...props} />;
}

function Draft({ chat, agent, ask, label, wait, state, drawn, edited }: Props) {
	const [edits, setEdits] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const interrupted = ask.interrupted === true;
	const readOnly = wait === undefined || interrupted;
	const { fields, rest, details } = draftParts(ask);
	const changes = fileChanges(rest);
	const facts = argList(changes.rest);
	const emailDraft = ask.tool === "gmail__send_message" && !interrupted;
	const emailRecipient = emailDraft
		? (edits.to ?? (typeof ask.args.to === "string" ? ask.args.to : "the chosen recipient"))
		: undefined;
	const eventDraft = CALENDAR_DRAFT.test(ask.tool) && !interrupted;
	const contactDraft = CONTACT_DRAFT.test(ask.tool) && !interrupted;
	const slackDraft = SLACK_DRAFT.test(ask.tool) && !interrupted;
	const slackReaction = SLACK_REACTION.test(ask.tool) && !interrupted;
	const what =
		emailRecipient !== undefined
			? `Send email to ${emailRecipient}`
			: eventDraft && ask.tool.endsWith("__create_event")
				? eventDraftWhat(ask.args, edits)
				: label;
	const driveDraft = DRIVE_DRAFT.test(ask.tool) && !interrupted;
	const preview = emailDraft || eventDraft || contactDraft || slackDraft;
	// the daemon's verb, where the effect has one of its own; never a word of the label, which may be a tool's name
	const verb = interrupted ? "Retry" : (ask.verb ?? "Allow");
	const scope = !interrupted && ask.floor === undefined ? scopesOf(ask)[0] : undefined;
	const asAgent = agent.id === undefined ? undefined : { id: agent.id, name: agent.name };
	return (
		<ApprovalCard
			agent={agent.name}
			what={what}
			verb={verb}
			declineLabel={interrupted ? "Skip" : undefined}
			as={ask.as}
			state={state ?? { kind: "open" }}
			scope={scope?.words}
			object={
				<>
					{interrupted ? (
						<p className="text-body text-ink">
							The earlier attempt may have happened. Retry runs the original action again, exactly as shown. Skip does
							not try again.
						</p>
					) : null}
					{drawn ?? (ask.on === undefined ? null : <ObjectPreviews chat={chat} asks={[ask.on]} agent={asAgent} />)}
					{emailDraft ? (
						<EmailDraftPreview
							args={ask.args}
							edits={edits}
							readOnly={readOnly || busy}
							onEdit={(name, value) => setEdits((prior) => ({ ...prior, [name]: value }))}
						/>
					) : eventDraft ? (
						<EventDraftPreview
							tool={ask.tool}
							args={ask.args}
							edits={edits}
							readOnly={readOnly || busy}
							onEdit={(name, value) => setEdits((prior) => ({ ...prior, [name]: value }))}
						/>
					) : slackDraft ? (
						<SlackDraftPreview
							args={ask.args}
							edits={edits}
							readOnly={readOnly || busy}
							onEdit={(name, value) => setEdits((prior) => ({ ...prior, [name]: value }))}
						/>
					) : slackReaction ? (
						<SlackReactionPreview args={ask.args} />
					) : contactDraft ? (
						<ContactDraftPreview tool={ask.tool} args={ask.args} />
					) : driveDraft ? (
						<DriveDraftPreview tool={ask.tool} args={ask.args} />
					) : facts.length === 0 ? null : (
						<Facts rows={facts} />
					)}
					{changes.files.length === 0 ? null : <FileChanges files={changes.files} />}
					{details.length === 0 ? null : <Details rows={details} />}
					{preview || fields.length === 0 ? null : (
						<FieldGroup>
							{fields.map((name) => {
								const drafted = String(ask.args[name]);
								// answered, the card reads what ran: the owner's text where they edited it
								const ran = edited?.[name];
								const value = readOnly ? (typeof ran === "string" ? ran : drafted) : (edits[name] ?? drafted);
								// `*` on an ask_hosts draft is every destination: flagged in red, on the text as edited
								const warning = name === "hosts" ? wildcardWarning(ask.tool, value) : undefined;
								return (
									<EditableText
										key={name}
										label={fieldLabel(name, fields)}
										value={value}
										original={drafted}
										line={!drafted.includes("\n") && TITLES.has(name)}
										disabled={busy}
										onChange={readOnly ? undefined : (next) => setEdits((prior) => ({ ...prior, [name]: next }))}
									>
										{warning === undefined ? null : <HostsWarning warning={warning} />}
									</EditableText>
								);
							})}
						</FieldGroup>
					)}
				</>
			}
			onApprove={async (scoped) => {
				if (wait === undefined) return;
				setBusy(true);
				try {
					await attempt(verb.toLowerCase(), () =>
						answerWait(
							wait,
							"approve",
							"approval",
							interrupted
								? {}
								: {
										edits,
										...(scoped && scope !== undefined ? { permission: scopeOf(scope.scope) } : {}),
									},
						),
					);
				} finally {
					setBusy(false);
				}
			}}
			onDecline={() =>
				wait === undefined ? undefined : attempt("decline", () => answerWait(wait, "deny", "approval"))
			}
		/>
	);
}
