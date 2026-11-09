/**
 * Class names, merged: `cn` that knows banda's own type sizes (tokens.css), so `text-ui` and `text-ink` are a size and
 * a colour, never two colours where one wins. Every component imports `cn` from here, never the bare package.
 */
import { createCn } from "cn/config";

export const cn = createCn({
	extend: {
		classGroups: {
			"font-size": [{ text: ["meta", "ui", "body", "heading", "display", "label", "title", "code"] }],
			rounded: [{ rounded: ["field", "tile", "bubble", "control", "block", "card", "chip"] }],
			shadow: [{ shadow: ["composer", "field", "field-focus"] }],
		},
	},
});
