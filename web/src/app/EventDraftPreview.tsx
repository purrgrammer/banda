import { useId } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { eventWhen } from "../chat/Object.tsx";

/** The Calendar changes a draft may be, by the tool's own name. */
export const CALENDAR_DRAFT = /^calendar__(create_event|update_event|respond_to_event|delete_event)$/;

const FIELDS = [
	{ name: "title", label: "Title" },
	{ name: "start", label: "Starts" },
	{ name: "end", label: "Ends" },
	{ name: "location", label: "Location" },
	{ name: "attendees", label: "Guests" },
	{ name: "description", label: "Description" },
] as const;

const TOLD: { readonly [value: string]: string } = {
	all: "Everyone invited",
	external: "Guests outside your organization",
	none: "No one",
};
const ANSWER: { readonly [value: string]: string } = {
	accepted: "Going",
	declined: "Not going",
	tentative: "Maybe",
};

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A new event's words as the owner edits it: what the card's heading says. */
export function eventDraftWhat(args: Record<string, unknown>, edits: Record<string, string>): string {
	const value = (name: string) => edits[name] ?? text(args[name]) ?? "";
	const title = value("title").trim();
	const when = eventWhen({ start: value("start"), end: value("end"), allDay: args.all_day === true });
	return `Create ${title === "" ? "an event" : `“${title}”`} on ${when}`;
}

/**
 * A Calendar change, as the owner approves it: a new or changed event's fields, editable while it waits; an answer to
 * an invitation; a deletion. The event it acts on is the card above it, drawn by the daemon.
 */
export function EventDraftPreview({
	tool,
	args,
	edits,
	readOnly,
	onEdit,
}: {
	tool: string;
	args: Record<string, unknown>;
	edits: Record<string, string>;
	readOnly: boolean;
	onEdit: (name: string, value: string) => void;
}) {
	const id = useId();
	const kind = CALENDAR_DRAFT.exec(tool)?.[1];
	const value = (name: string) => edits[name] ?? text(args[name]) ?? "";
	const fields = FIELDS.filter(({ name }) => typeof args[name] === "string");
	const start = value("start");
	const facts: [string, string][] = [];
	if ((kind === "create_event" || kind === "update_event") && (args.start !== undefined || args.end !== undefined))
		facts.push(["When", eventWhen({ start, end: value("end"), allDay: args.all_day === true })]);
	if (kind === "create_event" && args.add_meet === true) facts.push(["Video call", "Google Meet"]);
	if (kind === "respond_to_event") {
		facts.push(["Your answer", ANSWER[String(args.response)] ?? String(args.response)]);
		if (text(args.comment)) facts.push(["Note to the organizer", String(args.comment)]);
	}
	if (kind !== "respond_to_event")
		facts.push(["Google emails", TOLD[String(args.send_updates ?? "all")] ?? "Everyone invited"]);
	return (
		<section
			aria-label="Event draft"
			className="flex min-w-0 flex-col gap-3 rounded-field border border-line-soft bg-paper-2 p-3.5"
		>
			<p className="text-meta font-medium text-ink-2">
				{kind === "create_event"
					? "New event"
					: kind === "update_event"
						? "Changes"
						: kind === "respond_to_event"
							? "Answer"
							: "Delete event"}
			</p>
			<dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-meta">
				{facts.map(([name, said]) => (
					<div key={name} className="contents">
						<dt className="text-ink-2">{name}</dt>
						<dd className="text-ink [overflow-wrap:anywhere]">{said}</dd>
					</div>
				))}
			</dl>
			{fields.map(({ name, label }) => (
				<Field key={name} className="min-w-0 gap-1">
					<FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel>
					{name === "description" || name === "attendees" ? (
						<Textarea
							id={`${id}-${name}`}
							value={value(name)}
							readOnly={readOnly}
							placeholder={name === "attendees" ? "Email addresses, separated by commas" : undefined}
							className={`bg-paper text-body ${name === "description" ? "min-h-24" : "min-h-12"}`}
							onChange={(event) => onEdit(name, event.target.value)}
						/>
					) : (
						<Input
							id={`${id}-${name}`}
							value={value(name)}
							readOnly={readOnly}
							onChange={(event) => onEdit(name, event.target.value)}
						/>
					)}
				</Field>
			))}
		</section>
	);
}
