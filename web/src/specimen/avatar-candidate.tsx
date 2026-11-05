import { getExample } from "open-bot-avatar";
import { useState } from "react";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { AvatarCandidateCard } from "../avatar/CandidateCard.tsx";
import { DescribeFace } from "../avatar/DescribeFace.tsx";
import { AvatarRenderer } from "../avatar/Renderer.tsx";
import { Refused } from "../lib/api.ts";
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

/** Describe a face in the "+" sheet: here the designer answers after a pause with the mug, or refuses "fail". */
function Described() {
	const [drawn, setDrawn] = useState(defaultAvatarFace().definition);
	return (
		<div className="flex w-80 max-w-full flex-col gap-3">
			<AvatarRenderer definition={drawn} color={defaultAvatarFace().color} size={64} />
			<DescribeFace
				name="Earl"
				onDesigned={setDrawn}
				design={async (description) => {
					await new Promise((resolve) => setTimeout(resolve, 1200));
					const mug = getExample("mug");
					if (description === "fail" || !mug) throw new Refused("The answer didn't come out right. Try again.", 400);
					return mug;
				}}
			/>
		</div>
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
			<Group label="Described in the sheet · try Make one, or type fail">
				<Described />
			</Group>
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
