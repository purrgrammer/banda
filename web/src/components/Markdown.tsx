/**
 * A message as markdown, through Streamdown, loaded with `import()` so it stays out of the first bundle. The load
 * starts with the page, beside the transcript's first fetch; until it lands, the words show as plain text, their
 * syntax (`**`, `#`, link targets) left out rather than flashing raw. `streaming` renders an unfinished answer: an open
 * fence or list is closed for display instead of flashing raw syntax. Code blocks have no line numbers (a snippet, not a
 * file) and a copy button, coloured by the palette's code colours (`lib/highlight.ts`), and no empty line between an
 * item's text and a block inside it (`blocksApart`).
 */
import { type ComponentProps, createContext, lazy, type ReactNode, Suspense, useContext } from "react";
import { blocksApart } from "../lib/blocks.ts";
import { codePlugin } from "../lib/highlight.ts";
import { plainText } from "../lib/plain.ts";
import { BlobFile, linkedBlob } from "./Blob.tsx";
import { MentionChip, useMentioned } from "./MentionChip.tsx";

/** Optional, message-scoped rich links; ordinary markdown and code stay untouched. */
export const MarkdownLinks = createContext<((href: string) => ReactNode) | undefined>(undefined);

/**
 * A link: one to a blob (`[name](sha256:<hex>)`) is the file itself; a mention of a known agent its chip; any other
 * opens in a tab.
 */
function Link({ href, children, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
	const richLink = useContext(MarkdownLinks);
	const mentioned = useMentioned(href);
	if (mentioned !== undefined) return <MentionChip agent={mentioned} />;
	const sha = linkedBlob(href);
	if (sha !== undefined)
		return <BlobFile sha={sha} name={typeof children === "string" ? children : "file"} download="right" />;
	const rich = href === undefined ? undefined : richLink?.(href);
	if (rich != null) return rich;
	return (
		<a href={href} target="_blank" rel="noreferrer" {...props} data-markdown-link="">
			{children}
		</a>
	);
}

const loading = import("streamdown");
const Streamdown = lazy(async () => {
	const { Streamdown, defaultRehypePlugins, defaultUrlTransform } = await loading;
	const rehypePlugins = [...Object.values(defaultRehypePlugins), blocksApart];
	// a blob link survives; every other URL is made safe as Streamdown makes it
	const urlTransform: typeof defaultUrlTransform = (url, key, node) =>
		linkedBlob(url) === undefined ? defaultUrlTransform(url, key, node) : url;
	return {
		default: (props: Parameters<typeof Streamdown>[0]) => (
			<Streamdown rehypePlugins={rehypePlugins} urlTransform={urlTransform} components={{ a: Link }} {...props} />
		),
	};
});

/** A code block can be copied (a prompt, a command, a snippet); nothing else gets a control. */
const CONTROLS = { code: { copy: true, download: false }, table: false, mermaid: false } as const;
const PLUGINS = { code: codePlugin };

export function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
	return (
		<Suspense fallback={<div className="sa-markdown whitespace-pre-wrap">{plainText(children)}</div>}>
			<Streamdown
				className="sa-markdown"
				mode={streaming ? "streaming" : "static"}
				isAnimating={streaming}
				controls={CONTROLS}
				lineNumbers={false}
				plugins={PLUGINS}
			>
				{children}
			</Streamdown>
		</Suspense>
	);
}
