/** Exploration: the default face as the installed app's icon, standard and maskable. */
import { defaultAvatarFace } from "../../../../src/core/avatar-face.ts";
import { AvatarRenderer } from "../../avatar/Renderer.tsx";
import { Group, Section } from "../stage.tsx";

export function AppIcon() {
	const face = defaultAvatarFace();
	return (
		<Section id="avatar-icon" note="A preview of the default face as the installed app icon.">
			<Group label="Install icon · standard and maskable">
				{(["standard", "maskable"] as const).map((variant) => (
					<div key={variant} className="flex flex-col items-center gap-2">
						<span
							className="flex size-24 items-center justify-center overflow-hidden rounded-[22px] border border-line bg-paper-2"
							role="img"
							aria-label={`${variant} app icon`}
						>
							<AvatarRenderer definition={face.definition} color={face.color} size={variant === "standard" ? 78 : 64} />
						</span>
						<span className="text-meta text-ink-2">{variant}</span>
					</div>
				))}
			</Group>
		</Section>
	);
}
