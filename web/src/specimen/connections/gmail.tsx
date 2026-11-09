/** Gmail: an email as a card, a search and a conversation as lists, a draft to send, and the access to choose before connecting. */
import { useState } from "react";
import { EmailDraftPreview } from "../../app/EmailDraftPreview.tsx";
import { ConnectCard, ConnectDialog } from "../../chat/Connect.tsx";
import { EmailCard, MessagesCard } from "../../chat/Object.tsx";
import { Section } from "../stage.tsx";

const READ_ONLY = "https://www.googleapis.com/auth/gmail.readonly";

export function GmailSection() {
	const [permissions, setPermissions] = useState(false);
	const [scopes, setScopes] = useState<string[]>([READ_ONLY]);
	return (
		<Section
			id="gmail"
			note="Choose Google access before connecting. Sends and mailbox changes always ask for your approval."
		>
			<div className="grid gap-6 lg:grid-cols-2">
				<EmailCard
					message={{
						from: "Ana García <ana@example.com>",
						to: "bandarra@example.com",
						subject: "The launch checklist",
						date: "Today · 10:24",
						snippet: "Three things before Friday…",
						body: "Three things before Friday:\n\n1. Confirm the final copy.\n2. Review the rollout plan.",
						unread: true,
					}}
				/>
				<EmailDraftPreview
					args={{
						to: "mira@northstar.example",
						subject: "Re: quarterly planning",
						body: "Thanks, Mira. Friday at 10:30 works for me. I’ve attached the updated notes.",
						attachments: [{ name: "planning-notes.pdf", mimeType: "application/pdf", size: 1_258_291 }],
					}}
					edits={{}}
					readOnly
					onEdit={() => {}}
				/>
				<EmailCard
					message={{
						from: "Mira from Northstar <mira@northstar.example>",
						to: "bandarra@example.com",
						subject: "Re: quarterly planning",
						date: "Yesterday · 16:42",
						snippet: "I’ve attached the notes…",
						body: "Thanks for the thoughtful review. I’ve added the three dates we agreed on.",
						unread: false,
					}}
				/>
				<MessagesCard
					list={{
						title: "from:boss is:unread",
						search: true,
						total: 14,
						messages: [
							{
								id: "m3",
								from: "Inês Duarte <ines@example.com>",
								subject: "Numbers for Thursday's review",
								date: "Today · 11:02",
							},
							{
								id: "m2",
								from: "Inês Duarte <ines@example.com>",
								subject: "A very long subject that a forwarded thread might carry, naming every team and the quarter",
								date: "Today · 08:47",
							},
							{ id: "m1", from: "Inês Duarte <ines@example.com>", subject: "", date: "Yesterday · 19:30" },
						],
					}}
				/>
				<MessagesCard
					list={{
						title: "Re: quarterly planning",
						search: false,
						total: 3,
						messages: [
							{
								id: "m6",
								from: "Mira from Northstar <mira@northstar.example>",
								subject: "Re: quarterly planning",
								date: "Yesterday · 16:42",
							},
							{
								id: "m5",
								from: "Ana García <ana@example.com>",
								subject: "Re: quarterly planning",
								date: "Yesterday · 12:10",
							},
							{
								id: "m4",
								from: "Mira from Northstar <mira@northstar.example>",
								subject: "Quarterly planning",
								date: "Mon · 09:15",
							},
						],
					}}
				/>
				<MessagesCard list={{ title: "label:invoices after:2026/11/01", search: true, total: 0, messages: [] }} />
				<div className="lg:col-span-2">
					<ConnectCard
						agent="Sancho"
						connection="Gmail"
						id="gmail"
						state={{ kind: "connect", why: "Choose access, then sign in to Gmail." }}
						onConnect={() => setPermissions(true)}
					/>
					<ConnectDialog
						open={permissions}
						onOpenChange={setPermissions}
						agent="Sancho"
						connection="Gmail"
						id="gmail"
						step={{ kind: "permissions" }}
						scopes={scopes}
						onScopes={(next) => setScopes([...next])}
						scopesChanged={scopes.length > 1}
						onSignIn={() => setPermissions(false)}
					/>
				</div>
			</div>
		</Section>
	);
}
