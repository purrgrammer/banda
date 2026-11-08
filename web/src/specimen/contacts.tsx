/** Google Contacts' person cards: a saved contact, one emailed but not saved, no name, long words, and nothing but a name. */
import { Bubble } from "../chat/Feed.tsx";
import { ContactCard, ObjectLink, type Person } from "../chat/Object.tsx";
import { Section } from "./stage.tsx";

export const ANA: Person = {
	name: "Ana García",
	emails: "ana@northstar.example, ana.garcia@home.example",
	phones: "+34 600 123 456",
	organization: "Northstar",
	title: "Head of Design",
	other: false,
	url: "https://contacts.google.com/person/c1234567890",
};

export const PEOPLE: readonly (readonly [string, Person])[] = [
	["Saved contact", ANA],
	[
		"From people you've emailed",
		{ name: "Bo Lindqvist", emails: "bo@lindqvist.example", phones: "", organization: "", title: "", other: true },
	],
	[
		"No name",
		{
			name: "teo.ruiz@example.test",
			emails: "teo.ruiz@example.test",
			phones: "",
			organization: "",
			title: "",
			other: true,
		},
	],
	[
		"Very long name, company and address",
		{
			...ANA,
			name: "Maria-Fernanda de los Ángeles Villanueva-Castellanos y Ortega",
			emails:
				"maria.fernanda.villanueva-castellanos@a-very-long-company-domain-name-that-never-breaks.example, mf@vc.example",
			phones: "+1 (415) 555-0100, +34 911 222 333",
			organization: "The Northstar Collaborative for Very Long Organisation Names, Iberia Division",
			title: "Principal Program Manager, Partnerships and Strategic Alliances",
		},
	],
	["Only a name", { name: "Grandma", emails: "", phones: "", organization: "", title: "", other: false }],
];

export function ContactsSection() {
	return (
		<Section
			id="contacts"
			title="Google Contacts"
			note="People an agent names, drawn from banda's own reading. Read-only: nothing here adds or changes a contact."
		>
			<div className="grid gap-6 lg:grid-cols-2">
				{PEOPLE.map(([label, person]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<ContactCard person={person} />
					</div>
				))}
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Named in a message</span>
					<Bubble mine>
						Invite <ObjectLink object={{ ...ANA, card: "contact" }} href="contacts/pc1234567890" /> to the review
					</Bubble>
				</div>
			</div>
		</Section>
	);
}
