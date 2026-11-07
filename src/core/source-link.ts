/** Canonical local source links, shared by retrieval and the web renderer. */
export type SourceLink =
	| { kind: "message"; agent: string; entry?: number }
	| { kind: "group"; room: number; entry?: number }
	| { kind: "artifact"; id: string };

export function sourceLink(href: string | undefined): SourceLink | undefined {
	if (!href) return undefined;
	const message = /^#\/a\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\?at=([1-9]\d*))?$/.exec(href);
	const group = /^#\/g\/([1-9]\d{0,11})(?:\?at=([1-9]\d*))?$/.exec(href);
	const artifact = /^#\/artifact\/([0-9a-z]{1,64})(?:\?v=([1-9]\d*))?$/.exec(href);
	const match = message ?? group ?? artifact;
	if (!match || (match[2] !== undefined && !Number.isSafeInteger(Number(match[2])))) return undefined;
	const entry = match[2] === undefined ? {} : { entry: Number(match[2]) };
	if (message?.[1]) return { kind: "message", agent: message[1], ...entry };
	if (group) return { kind: "group", room: Number(group[1]), ...entry };
	return artifact?.[1] ? { kind: "artifact", id: artifact[1] } : undefined;
}
