/** The Contacts changes a draft may be, by the tool's own name. */
export const CONTACT_DRAFT = /^contacts__(create_contact|update_contact|delete_contact)$/;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const items = (value: unknown) =>
	Array.isArray(value) ? value.filter((each): each is string => typeof each === "string").join(", ") : text(value);

/** A new contact's heading, as the daemon words it. */
const name = (args: Record<string, unknown>) =>
	text(args.name)?.trim() || [text(args.given_name), text(args.family_name)].filter(Boolean).join(" ").trim();

/**
 * A Contacts change, as the owner approves it: the fields that will be set, read-only (the owner approves exactly what
 * was drafted, or denies and says what to change). The contact it acts on is the card above it, drawn by the daemon.
 */
export function ContactDraftPreview({ tool, args }: { tool: string; args: Record<string, unknown> }) {
	const kind = CONTACT_DRAFT.exec(tool)?.[1];
	const cleared = (value: string | undefined) => (value === "" ? "Removed" : value);
	const facts: [string, string | undefined][] = [
		["Name", name(args) || undefined],
		["Emails", cleared(items(args.emails))],
		["Phones", cleared(items(args.phones))],
		["Company", cleared(text(args.organization))],
		["Job title", cleared(text(args.title))],
		["Notes", cleared(text(args.notes))],
	];
	const shown = facts.filter((fact): fact is [string, string] => fact[1] !== undefined);
	if (kind === "delete_contact") return null;
	return (
		<section
			aria-label="Contact draft"
			className="flex min-w-0 flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-3.5"
		>
			<p className="text-meta font-medium text-ink-2">{kind === "create_contact" ? "New contact" : "Changes"}</p>
			<dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
				{shown.map(([label, said]) => (
					<div key={label} className="contents">
						<dt className="text-ink-2">{label}</dt>
						<dd className="text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">{said}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}
