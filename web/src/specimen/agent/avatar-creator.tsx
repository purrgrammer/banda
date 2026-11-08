/** Choosing a face: the app's picker, shape and colour accepted together, and the face it yields. */
import { useState } from "react";
import { defaultAvatarFace } from "../../../../src/core/avatar-face.ts";
import { AvatarChoices } from "../../avatar/Choices.tsx";
import { Face } from "../../chat/Face.tsx";
import { Group, Section } from "../stage.tsx";

export function AvatarCreator() {
	const [face, setFace] = useState(defaultAvatarFace);
	return (
		<Section id="avatar-creator" note="Choices stay here; the app saves them to the agent.">
			<Group label="The app's picker · shape and colour are accepted together" className="items-start">
				<div className="w-80 max-w-full rounded-tile border border-line">
					<AvatarChoices initial={face} name="Mara" onPick={setFace} />
				</div>
				<Face face={face} name="Mara, chosen face" size="panel" />
			</Group>
		</Section>
	);
}
