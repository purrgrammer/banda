/** Local source references keep their label and type visible without opening a preview. */
import { FileTextIcon, MessageSquareIcon, UsersIcon } from "lucide-react";
import {
	type ComponentProps,
	createContext,
	isValidElement,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { type SourceLink as Source, sourceLink } from "../../../src/core/source-link.ts";
import { api } from "../lib/api.ts";

const TYPES = {
	message: { Icon: MessageSquareIcon, name: "Message" },
	group: { Icon: UsersIcon, name: "Group" },
	artifact: { Icon: FileTextIcon, name: "Artifact" },
};

/** Specimens can supply entity labels without reading a real home. */
export const SourceLabels = createContext<(href: string) => Promise<{ label: string } | null>>((href) =>
	api(`/search/source?href=${encodeURIComponent(href)}`),
);

function hasLabel(node: ReactNode): boolean {
	if (typeof node === "string") return node.trim().length > 0;
	if (typeof node === "number") return true;
	if (Array.isArray(node)) return node.some(hasLabel);
	return isValidElement<{ children?: ReactNode }>(node) && hasLabel(node.props.children);
}

export function SourceReference({ href, children, ...props }: ComponentProps<"a"> & { href: string }) {
	const source = sourceLink(href) as Source;
	const { Icon, name } = TYPES[source.kind];
	const explicit = hasLabel(children);
	const load = useContext(SourceLabels);
	const [resolved, setResolved] = useState<{ href: string; label: string }>();
	useEffect(() => {
		if (explicit) return;
		let gone = false;
		void load(href)
			.then((value) => {
				if (!gone && value?.label.trim()) setResolved({ href, label: value.label });
			})
			.catch(() => {});
		return () => {
			gone = true;
		};
	}, [href, explicit, load]);
	return (
		<a {...props} href={href} target={undefined} data-markdown-link="" data-source-kind={source.kind} title={name}>
			<Icon aria-hidden="true" className="mr-1 inline size-[1em] align-[-0.125em]" />
			<span className="sr-only">{name}: </span>
			{explicit ? children : resolved?.href === href ? resolved.label : name}
		</a>
	);
}
