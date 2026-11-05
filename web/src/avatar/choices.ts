import { getExample, validateAvatar } from "open-bot-avatar";

/** Gallery shapes are copied into the identity; rendering never depends on a gallery id. */
export const SHAPES = (
	[
		["chat", "Chat"],
		["mug", "Mug"],
		["controller", "Controller"],
		["lightbulb", "Lightbulb"],
		["watering-can", "Watering can"],
		["barbell", "Barbell"],
		["sprout", "Sprout"],
	] as const
).map(([id, name]) => {
	const checked = validateAvatar(getExample(id));
	if (!checked.ok) throw new Error(`Invalid avatar shape: ${id}`);
	return { id, name, definition: checked.value };
});

export const COLORS = [
	{ name: "Sky", value: "#8a9cc7" },
	{ name: "Apricot", value: "#e48c54" },
	{ name: "Leaf", value: "#56a875" },
	{ name: "Lavender", value: "#8b85d0" },
	{ name: "Honey", value: "#d4ae47" },
	{ name: "Teal", value: "#66a8a3" },
	{ name: "Rose", value: "#c9707b" },
] as const;

export function customColors(initial: string, added: readonly string[]): string[] {
	return [...new Set([initial, ...added])].filter((color) => !COLORS.some((item) => item.value === color));
}
