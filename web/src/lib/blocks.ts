/**
 * A rehype pass for replies. Their items keep typed line breaks (`white-space: pre-line`), so the newline markdown
 * leaves between an item's text and a block inside it (a code block, a nested list) would show as an empty line. This
 * drops the newlines that only separate a block from its siblings; a line break within text stays.
 */
type Node = { type: string; tagName?: string; value?: string; children?: Node[] };

const BLOCKS = new Set([
	"pre",
	"ul",
	"ol",
	"p",
	"blockquote",
	"table",
	"hr",
	"div",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
]);
const block = (node: Node | undefined) => node?.type === "element" && BLOCKS.has(node.tagName ?? "");

function trim(node: Node): void {
	const children = node.children;
	if (children === undefined) return;
	children.forEach((child, i) => {
		if (child.type === "text" && child.value !== undefined) {
			if (block(children[i - 1])) child.value = child.value.replace(/^\n+/, "");
			if (block(children[i + 1])) child.value = child.value.replace(/\n+$/, "");
		} else trim(child);
	});
	node.children = children.filter((child) => child.type !== "text" || child.value !== "");
}

export const blocksApart = () => (tree: Node) => trim(tree);
