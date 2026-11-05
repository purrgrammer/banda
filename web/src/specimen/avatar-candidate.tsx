import { getExample } from "open-bot-avatar";
import { useState } from "react";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { AvatarCandidateCard } from "../avatar/CandidateCard.tsx";
import { Group, Section } from "./stage.tsx";

function Candidate() {
	const [current, setCurrent] = useState(defaultAvatarFace);
	const definition = getExample("mug");
	if (!definition) return null;
	return (
		<AvatarCandidateCard
			definition={definition}
			current={current}
			name="Mira"
			onUse={async (face) => setCurrent(face)}
		/>
	);
}

export function AvatarCandidateSpecimen() {
	const current = defaultAvatarFace();
	const definition = getExample("mug");
	if (!definition) return null;
	return (
		<Section
			id="avatar-candidate"
			title="A generated face"
			note="Geometry arrives as a preview card. Nothing changes until the owner uses it."
		>
			<Group label="Preview · try Use this face">
				<Candidate />
			</Group>
			<Group label="Already in use">
				<AvatarCandidateCard definition={current.definition} current={current} name="Mira" onUse={async () => {}} />
			</Group>
			<Group label="A failed save · try Use this face">
				<AvatarCandidateCard
					definition={definition}
					current={current}
					name="Mira"
					onUse={async () => {
						throw new Error("Offline");
					}}
				/>
			</Group>
		</Section>
	);
}
