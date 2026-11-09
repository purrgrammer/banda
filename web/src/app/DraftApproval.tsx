/** One approval view for direct chats and groups: the daemon's verb, account, stored facts and editable bytes. */

import { type ReactNode, useId, useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ApprovalCard, type ApprovalState, Details, Facts, HostsWarning } from "../chat/Approval.tsx";
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

type Props = {
	chat: number;
	agent: { readonly id?: string | undefined; readonly name: string };
	ask: Extract<Ask, { type: "approval" }>;
	label: string;
	wait?: string | undefined;
	state?: ApprovalState | undefined;
	/** The object the draft acts on, drawn already (the specimen's), instead of read from the daemon. */
	drawn?: ReactNode;
};

/**
 * What the owner does on a card (the scope ticked, the text edited) is that ask's alone: a card is drawn afresh for
 * each Wait, so another ask in the same place of the feed never starts with the last one's tick.
 */
export function DraftApproval(props: Props) {
	return <Draft key={props.wait ?? "answered"} {...props} />;
}

function Draft({ chat, agent, ask, label, wait, state, drawn }: Props) {
	const id = useId();
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
	const what =
		emailRecipient !== undefined
			? `Send email to ${emailRecipient}`
			: eventDraft && ask.tool.endsWith("__create_event")
				? eventDraftWhat(ask.args, edits)
				: label;
	const driveDraft = DRIVE_DRAFT.test(ask.tool) && !interrupted;
	const preview = emailDraft || eventDraft || contactDraft;
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
								const value = edits[name] ?? String(ask.args[name]);
								// `*` on an ask_hosts draft is every destination: flagged in red, on the text as edited
								const warning = name === "hosts" ? wildcardWarning(ask.tool, value) : undefined;
								return (
									<Field key={name}>
										<FieldLabel htmlFor={readOnly ? undefined : `${id}-${name}`}>
											{name === "body" ? "What will be sent" : name.replaceAll("_", " ")}
										</FieldLabel>
										{readOnly ? (
											<p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{String(ask.args[name])}</p>
										) : (
											<Textarea
												id={`${id}-${name}`}
												value={value}
												disabled={busy}
												onChange={(event) => setEdits((prior) => ({ ...prior, [name]: event.target.value }))}
											/>
										)}
										{warning === undefined ? null : <HostsWarning warning={warning} />}
									</Field>
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
