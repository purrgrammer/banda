// The band as the site's hero and the README's header draw it: who, in what shape and colour, how big, how high, how tilted.
import type { AvatarMotion } from "open-bot-avatar";

export type Member = {
	name: string;
	shape: string;
	color: string;
	/** Width and height, in CSS pixels. */
	size: number;
	/** Raised above the shared baseline, in CSS pixels. */
	lift: number;
	/** Rotation, in degrees. */
	tilt: number;
	/** The mood the README's still picture shows. */
	still: AvatarMotion;
};

export const BAND: Member[] = [
	{ name: "Mara", shape: "mug", color: "#e48c54", size: 64, lift: 22, tilt: -8, still: "happy" },
	{ name: "Octo", shape: "controller", color: "#8b85d0", size: 84, lift: 0, tilt: 5, still: "idle" },
	{ name: "Sancho", shape: "chat", color: "#8a9cc7", size: 128, lift: 14, tilt: -2, still: "idle" },
	{ name: "Atlas", shape: "lightbulb", color: "#d4ae47", size: 56, lift: 48, tilt: 10, still: "thinking" },
	{ name: "Otto", shape: "sprout", color: "#56a875", size: 92, lift: 4, tilt: -6, still: "happy" },
];

/** The space between neighbours and the row's height, in CSS pixels. */
export const GAP = 4;
export const HEIGHT = 168;
