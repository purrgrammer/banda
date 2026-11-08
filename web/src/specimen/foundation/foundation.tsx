/** The foundation: colour, type, shape and motion, as tokens.css defines them. */
import { Face } from "../../chat/Face.tsx";
import { MARA } from "../fixtures.ts";
import { Group, Section } from "../stage.tsx";

const COLOURS: readonly (readonly [string, string])[] = [
	["paper", "The page"],
	["paper-2", "The sidebar; the owner's bubbles"],
	["paper-3", "A hovered row; a well in a card; the face's disc"],
	["line", "A hairline around a card or a field"],
	["line-soft", "A divider between rows"],
	["ink", "What people read; the primary button"],
	["ink-2", "Secondary text, still 4.5:1"],
	["ink-3", "Decoration only: markers and dividers, never text"],
	["focus", "The focus outline"],
	["alive", "An agent at work, and nothing else"],
	["danger", "A failure"],
];

export function Foundation() {
	return (
		<>
			<Section
				id="colour"
				note="Neutrals at chroma 0. One colour means alive, one means a failure; the faces bring the rest."
			>
				<div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
					{COLOURS.map(([name, role]) => (
						<div key={name} className="flex flex-col gap-1.5">
							<div className="h-12 rounded-field border border-line-soft" style={{ background: `var(--${name})` }} />
							<p className="font-code text-meta text-ink">{name}</p>
							<p className="text-meta text-ink-2">{role}</p>
						</div>
					))}
				</div>
			</Section>
			<Section id="type" note="Geist for people, Geist Mono for machines. Each size has one role.">
				<div className="flex flex-col gap-4">
					<p className="text-display font-semibold">Display · the first-run screen</p>
					<p className="text-heading font-semibold">Heading · a sheet's title, a section</p>
					<p className="max-w-[var(--measure)] text-body">
						Body · what is said in the chat. Mara found three flights under €300 and kept the window seat you like; the
						cheapest leaves at 7:40, which you usually avoid.
					</p>
					<p className="text-ui">Ui · a row's name, a button, a field</p>
					<p className="text-meta text-ink-2">Meta · 10:42 · 3 unread · as of yesterday</p>
					<p className="font-code text-ui">Code · git push origin main</p>
				</div>
			</Section>
			<Section
				id="shape"
				note="A hairline and a radius; no shadows but the composer's. Fields 8, tiles 14, bubbles 20."
			>
				<Group label="Radii">
					<div className="flex h-10 w-28 items-center justify-center rounded-field border border-line text-meta">
						field 8
					</div>
					<div className="flex h-16 w-32 items-center justify-center rounded-tile border border-line text-meta">
						tile 14
					</div>
					<div className="flex h-10 items-center rounded-bubble bg-paper-2 px-4 text-body">bubble 20</div>
				</Group>
				<Group label="The composer, the one thing that floats">
					<div className="flex h-12 w-full max-w-md items-center rounded-tile bg-paper px-4 text-body text-ink-2 shadow-composer">
						Message Mara
					</div>
				</Group>
			</Section>
			<Section
				id="motion"
				note="Motion only says something changed or something is alive: a slow ring while an agent works. Under reduced motion the ring stands still."
			>
				<Group label="Alive">
					<Face {...MARA} size="panel" state="working" />
				</Group>
			</Section>
		</>
	);
}
