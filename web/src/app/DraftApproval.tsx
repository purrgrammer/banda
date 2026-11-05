/** One approval view for direct chats and groups: the daemon's verb, account, stored facts and editable bytes. */
import { useId, useState } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ApprovalCard, type ApprovalState, Facts } from "../chat/Approval.tsx";
import { FileChanges } from "../chat/FileChanges.tsx";
import { type Ask, answerWait } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { argList } from "../lib/chat.ts";
import { fileChanges } from "../lib/file-changes.ts";
import { scopeOf, scopesOf } from "../lib/permissions.ts";
import { ObjectPreviews } from "./Objects.tsx";

export function DraftApproval({
	chat,
	agent,
	ask,
	label,
	wait,
	state,
}: {
	chat: number;
	agent: { readonly id?: string | undefined; readonly name: string };
	ask: Extract<Ask, { type: "approval" }>;
	label: string;
	wait?: string | undefined;
	state?: ApprovalState | undefined;
}) {
	const id = useId();
	const [edits, setEdits] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const interrupted = ask.interrupted === true;
	const readOnly = wait === undefined || interrupted;
	const fields = (ask.editable ?? []).filter((name) => typeof ask.args[name] === "string");
	const changes = fileChanges(Object.fromEntries(Object.entries(ask.args).filter(([name]) => !fields.includes(name))));
	const facts = argList(changes.rest);
	const first = label.split(" ")[0] ?? "";
	const verb = interrupted
		? "Retry"
		: (ask.verb ?? (first === "" || first.length > 12 ? "Allow" : first.charAt(0).toUpperCase() + first.slice(1)));
	const scope = !interrupted && ask.floor === undefined ? scopesOf(ask)[0] : undefined;
	const asAgent = agent.id === undefined ? undefined : { id: agent.id, name: agent.name };
	return (
		<ApprovalCard
			agent={agent.name}
			what={label}
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
					{ask.on === undefined ? null : <ObjectPreviews chat={chat} asks={[ask.on]} agent={asAgent} />}
					{facts.length === 0 ? null : <Facts rows={facts} />}
					{changes.files.length === 0 ? null : <FileChanges files={changes.files} />}
					{fields.length === 0 ? null : (
						<FieldGroup>
							{fields.map((name) => (
								<Field key={name}>
									<FieldLabel htmlFor={readOnly ? undefined : `${id}-${name}`}>
										{name === "body" ? "What will be sent" : name.replaceAll("_", " ")}
									</FieldLabel>
									{readOnly ? (
										<p className="text-body whitespace-pre-wrap [overflow-wrap:anywhere]">{String(ask.args[name])}</p>
									) : (
										<Textarea
											id={`${id}-${name}`}
											value={edits[name] ?? String(ask.args[name])}
											disabled={busy}
											onChange={(event) => setEdits((prior) => ({ ...prior, [name]: event.target.value }))}
										/>
									)}
								</Field>
							))}
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
