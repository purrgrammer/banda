/** The band: rows in every state, the sidebar, the rail, an empty band, search. */
import { BandNotice } from "../chat/Band.tsx";
import { Row } from "../chat/Row.tsx";
import { type Hit, Search } from "../chat/Search.tsx";
import { Band } from "./brand.tsx";
import { MARA, ROWS, SANCHO } from "./fixtures.ts";
import { Group, Section } from "./stage.tsx";

const HITS: readonly Hit[] = [
	{
		id: "1",
		who: MARA,
		before: "Three flights to Lisbon on ",
		match: "Sa",
		after: "turday, all mornings",
		when: "Today",
	},
	{
		id: "2",
		who: { chip: "you", name: "You" },
		before: "Does ",
		match: "Sa",
		after: "turday work for everyone?",
		when: "12 Oct",
	},
	{
		id: "3",
		who: { chip: "artifact", name: "Trip plan" },
		before: "Leave ",
		match: "Sa",
		after: "turday early, back Monday night",
		when: "Artifact",
	},
];

const LOCALS = {
	agents: [{ ...SANCHO, id: "sancho" }],
	skills: [{ name: "xlsx", description: "Spreadsheets, summed up" }],
	pages: [
		{ id: "skills", label: "Skills" },
		{ id: "settings", label: "Settings" },
	] as const,
};

export function BandSection() {
	return (
		<>
			<Section
				id="rows"
				title="Rows"
				note="Unread is ink; an open ask reads as the ask; the face says working, waiting or resting."
			>
				<div className="flex max-w-[var(--sidebar-width)] flex-col gap-0.5 rounded-tile bg-paper-2 p-2">
					{ROWS.map((row, i) => (
						<Row key={row.id} row={row} selected={i === 1} />
					))}
				</div>
			</Section>
			<Section
				id="sidebar"
				title="The sidebar"
				note="The band, search, + and the menu (Skills, Connections, Settings; a dot while something there waits on you); the daemon's notices at the foot."
			>
				<div className="flex h-[560px] gap-4 overflow-x-auto">
					<Band
						rows={ROWS}
						selected="octo"
						className="rounded-tile"
						waiting={{ skills: true }}
						notice={<BandNotice>Your computer is starting…</BandNotice>}
					/>
					<Band rows={ROWS} selected="octo" collapsed className="rounded-tile" />
					<Band rows={[]} className="rounded-tile" />
				</div>
			</Section>
			<Section
				id="search"
				title="Search"
				note="⌘K: with nothing typed, the band to switch to; typed, agents, skills and pages found at once, then the chats. A hit opens its chat at that message."
			>
				<Group label="Nothing typed: the band's rows, in the band's order">
					<Search query="" recent={ROWS} />
				</Group>
				<Group label="A query: agents, skills, pages, then the chats">
					<Search query="sa" {...LOCALS} hits={HITS} />
				</Group>
				<Group label="A new search runs: the previous hits stay, dimmed">
					<Search query="sat" {...LOCALS} hits={HITS} searching stale />
				</Group>
				<Group label="Searching with nothing kept · nothing found · failed, with Try again" className="items-start">
					<Search query="lisbon" searching />
					<Search query="kyoto" />
					<Search query="porto" onRetry={() => {}} />
				</Group>
				<Group label="The phone: Cancel closes it">
					<div className="w-[390px] max-w-full">
						<Search query="" recent={ROWS.slice(0, 3)} phone />
					</div>
				</Group>
				<Group label="Phone width: rows at full width">
					<div className="flex w-[390px] max-w-full flex-col gap-0.5 rounded-tile bg-paper-2 p-2">
						{ROWS.slice(0, 3).map((row) => (
							<Row key={row.id} row={row} />
						))}
					</div>
				</Group>
			</Section>
		</>
	);
}
