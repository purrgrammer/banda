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

/**
 * Text on one line, at most `max` long. Cut at its end, unless `ends` says what must stay (a command's last step, a
 * path's file name, a trailing " · submit"): then the cut is before it.
 */
export function shortPreview(text: string, ends?: (text: string) => Ends, max = 180): string {
	const one = text.replace(/\s+/g, " ").trim();
	const { head, end } = capEnds(ends === undefined ? { head: one, end: "" } : ends(one), max);
	return head + end;
}

/** How long a preview whose end matters may be: two lines on a phone, so the clamp under it never takes the end. */
const KEPT = 88;

export function toolPreview(name: string, args: Readonly<Record<string, unknown>>): string | undefined {
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
	return value ? (ends === undefined ? shortPreview(value) : shortPreview(value, ends, KEPT)) : undefined;
}
