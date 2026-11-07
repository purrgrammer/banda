/** The band: rows in every state, the sidebar, the rail, an empty band, search. */
import { BandNotice } from "../chat/Band.tsx";
import { Row } from "../chat/Row.tsx";
import { Search } from "../chat/Search.tsx";
import { Band } from "./brand.tsx";
import { MARA, OCTO, ROWS, SANCHO } from "./fixtures.ts";
import { Group, Section } from "./stage.tsx";

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
			<Section id="search" title="Search" note="⌘K: a result opens its chat at that message.">
				<Search
					query="lisbon"
					hits={[
						{
							id: "1",
							who: MARA,
							before: "Three flights to ",
							match: "Lisbon",
							after: " under €300, all mornings",
							when: "Today",
						},
						{
							id: "2",
							who: SANCHO,
							before: "Your sister lives in ",
							match: "Lisbon",
							after: "; she asked about May",
							when: "12 Oct",
						},
						{ id: "3", who: OCTO, before: "The ", match: "lisbon", after: "-trip branch is stale", when: "3 Sep" },
					]}
				/>
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
