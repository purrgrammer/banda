/** Faces: an agent's accepted avatar at every size, its states, and a group's stacked faces. */
import { Face, FaceStack } from "../../chat/Face.tsx";
import { ATLAS, MARA, OCTO, SANCHO, sampleFace } from "../fixtures.ts";
import { Group, Section } from "../stage.tsx";

const BAND = [
	SANCHO,
	MARA,
	OCTO,
	ATLAS,
	{ face: sampleFace("watering-can", "#66a8a3"), name: "Dune" },
	{ face: sampleFace("barbell", "#d99368"), name: "Bea" },
] as const;

export function Faces() {
	return (
		<Section
			id="faces"
			note="Each agent has a shape and colour. Thinking animates the face; a quiet dot marks waiting."
		>
			<Group label="Sizes: hero 96 · panel 64 · row 40 · message 28 · mention 20">
				<Face {...SANCHO} size="hero" />
				<Face {...SANCHO} size="panel" />
				<Face {...SANCHO} size="row" />
				<Face {...SANCHO} size="message" />
				<Face {...SANCHO} size="mention" />
			</Group>
			<Group label="States: idle · working · happy · waiting on you · routines paused" className="gap-6">
				<Face {...MARA} />
				<Face {...MARA} state="working" />
				<Face {...MARA} state="happy" />
				<Face {...MARA} state="waiting" />
				<Face {...MARA} paused />
			</Group>
			<Group label="The same at panel size" className="gap-6">
				<Face {...OCTO} size="panel" />
				<Face {...OCTO} size="panel" state="working" />
				<Face {...OCTO} size="panel" state="happy" />
				<Face {...OCTO} size="panel" state="waiting" />
				<Face {...OCTO} size="panel" paused />
			</Group>
			<Group label="A group: two shapes and a count; the working member comes forward" className="gap-6">
				<FaceStack name="Trip" faces={BAND.slice(0, 2)} />
				<FaceStack name="Desk" faces={BAND.slice(0, 3)} />
				<FaceStack name="Everyone" faces={BAND} />
				<FaceStack name="Trip" faces={BAND.slice(0, 2)} size="panel" />
				<FaceStack name="Trip" faces={[{ ...BAND[0], state: "working" }, BAND[1]]} />
				<FaceStack name="Trip" faces={[BAND[0], { ...BAND[1], state: "working" }]} />
				<FaceStack name="New group" faces={[]} />
				<FaceStack name="New group" faces={[]} size="panel" />
			</Group>
			<Group label="A band of faces" className="gap-4">
				{BAND.map((face) => (
					<Face key={face.name} {...face} />
				))}
			</Group>
		</Section>
	);
}
