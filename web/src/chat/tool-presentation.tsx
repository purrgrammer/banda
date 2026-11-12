/** Presentation only: a tool's identity and a short, literal glimpse of its arguments, never a new model summary. */
import {
	ArrowDownUpIcon,
	BookOpenIcon,
	CalendarClockIcon,
	CameraIcon,
	ClockIcon,
	FilePenLineIcon,
	FilePlusIcon,
	FileTextIcon,
	GlobeIcon,
	HandIcon,
	KeyRoundIcon,
	LibraryIcon,
	ListFilterIcon,
	type LucideIcon,
	MemoryStickIcon,
	MessageCircleIcon,
	MessageCircleQuestionIcon,
	MessagesSquareIcon,
	MonitorIcon,
	MousePointer2Icon,
	NavigationIcon,
	PlugIcon,
	SearchIcon,
	SendIcon,
	SmileIcon,
	TerminalIcon,
	TextCursorInputIcon,
	Trash2Icon,
	UserRoundIcon,
	WrenchIcon,
} from "lucide-react";
import { capEnds, commandEnds, type Ends, pathEnds, suffixEnds } from "@/lib/ends";

const ICONS: Record<string, LucideIcon> = {
	message_user: MessageCircleIcon,
	message_group: MessagesSquareIcon,
	ask_user: MessageCircleQuestionIcon,
	react: SmileIcon,
	publish: LibraryIcon,
	connect: PlugIcon,
	propose_avatar: UserRoundIcon,
	schedule: CalendarClockIcon,
	skill: BookOpenIcon,
	bash: TerminalIcon,
	write: FilePlusIcon,
	edit: FilePenLineIcon,
	read: FileTextIcon,
	web_fetch: GlobeIcon,
	browser_snapshot: MonitorIcon,
	browser_navigate: NavigationIcon,
	browser_click: MousePointer2Icon,
	browser_type: TextCursorInputIcon,
	browser_select: ListFilterIcon,
	browser_scroll: ArrowDownUpIcon,
	browser_wait: ClockIcon,
	browser_screenshot: CameraIcon,
	browser_send: SendIcon,
	browser_hand_over: HandIcon,
	propose_key: KeyRoundIcon,
	remember: MemoryStickIcon,
	recall: MemoryStickIcon,
	search: SearchIcon,
	read_search_result: BookOpenIcon,
	forget: Trash2Icon,
};

export function toolIcon(name: string): LucideIcon {
	return Object.hasOwn(ICONS, name) ? (ICONS[name] ?? WrenchIcon) : WrenchIcon;
}
export function ToolIcon({ name }: { name: string }) {
	const Icon = toolIcon(name);
	return <Icon aria-hidden="true" data-tool-icon={name} className="size-4" />;
}

export function shortPreview(text: string): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > 180 ? `${one.slice(0, 179)}…` : one;
}

/** A call's preview as one line of text, at most 180 long, cut before what must stay (see `toolPreviewEnds`). */
export function toolPreview(name: string, args: Readonly<Record<string, unknown>>): string | undefined {
	const ends = toolPreviewEnds(name, args);
	return ends === undefined ? undefined : ends.head + ends.end;
}

/**
 * A call's preview split for the eye: `end` is what must stay when the line runs out of room (a command's last step,
 * a path's file name, a trailing " · submit"), empty when nothing must. Drawn with chat/KeepEnd.tsx, the head gives way
 * on screen at any width; the cap in characters only bounds how much text there is.
 */
export function toolPreviewEnds(name: string, args: Readonly<Record<string, unknown>>): Ends | undefined {
	const text = (...keys: string[]) =>
		keys.flatMap((key) => (typeof args[key] === "string" && args[key] !== "" ? [String(args[key])] : [])).join(" · ");
	let value: string;
	// what must stay when the preview is cut: none, by default
	let ends: ((text: string) => Ends) | undefined;
	switch (name) {
		case "message_user":
		case "message_group":
			value = text("text");
			break;
		case "ask_user":
			value = text("question");
			break;
		case "react":
			value = text("reaction");
			break;
		case "publish":
			value = text("title", "change") || text("path");
			break;
		case "connect":
			value = text("connection", "reason");
			break;
		case "schedule":
			value = text("name", "description", "cron", "at") || (args.every ? `Every ${args.every}s` : "");
			break;
		case "skill":
			value = text("name");
			break;
		case "bash":
			value = text("command");
			ends = commandEnds;
			break;
		case "read":
			value = text("path") + (typeof args.offset === "number" ? ` · from line ${args.offset}` : "");
			ends = pathEnds;
			break;
		case "write":
		case "edit":
			value = text("path");
			ends = pathEnds;
			break;
		case "web_fetch":
		case "browser_navigate":
			value = text("url");
			ends = pathEnds;
			break;
		case "browser_click":
			value = text("ref");
			break;
		case "browser_type":
			value = text("ref", "text") + (args.submit ? " · submit" : "");
			ends = suffixEnds;
			break;
		case "browser_select":
			value = text("ref") + (Array.isArray(args.values) ? ` · ${args.values.join(", ")}` : "");
			break;
		case "browser_scroll":
			value = text("direction", "ref") + (typeof args.pages === "number" ? ` · ${args.pages} pages` : "");
			break;
		case "browser_wait":
			value = text("text") || (typeof args.seconds === "number" ? `${args.seconds}s` : "");
			break;
		case "browser_snapshot":
			value = "Current page";
			break;
		case "browser_screenshot":
			value = "Current viewport";
			break;
		case "browser_send":
			value = text("write");
			break;
		case "browser_hand_over":
			value = text("site", "why");
			break;
		// A credential is not a useful collapsed preview. Its connection and host are.
		case "propose_key":
			value = text("connection", "host");
			break;
		case "remember":
			value = text("fact");
			break;
		case "search":
		case "recall":
			value = text("query");
			break;
		case "forget":
			value = text("id");
			break;
		default:
			value = text("path", "url", "query");
	}
	if (!value) return undefined;
	const one = value.replace(/\s+/g, " ").trim();
	return capEnds(ends === undefined ? { head: one, end: "" } : ends(one), 180);
}
