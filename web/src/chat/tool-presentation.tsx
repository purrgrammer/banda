/** Presentation only: a tool's identity and a short, literal glimpse of its arguments, never a new model summary. */
import {
	ArrowDownUpIcon,
	BookOpenIcon,
	CalendarClockIcon,
	CameraIcon,
	ClipboardListIcon,
	ClockIcon,
	FilePenLineIcon,
	FilePlusIcon,
	FileTextIcon,
	GlobeIcon,
	HandIcon,
	KeyRoundIcon,
	ListFilterIcon,
	type LucideIcon,
	MemoryStickIcon,
	MessageCircleIcon,
	MessagesSquareIcon,
	MonitorIcon,
	MousePointer2Icon,
	NavigationIcon,
	SearchIcon,
	SendIcon,
	TerminalIcon,
	TextCursorInputIcon,
	Trash2Icon,
	WrenchIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
	message_user: MessageCircleIcon,
	message_group: MessagesSquareIcon,
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
	propose_send: ClipboardListIcon,
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

export function toolPreview(name: string, args: Readonly<Record<string, unknown>>): string | undefined {
	const text = (...keys: string[]) =>
		keys.flatMap((key) => (typeof args[key] === "string" && args[key] !== "" ? [String(args[key])] : [])).join(" · ");
	let value: string;
	switch (name) {
		case "message_user":
		case "message_group":
			value = text("text", "question");
			break;
		case "schedule":
			value = text("name", "description", "cron", "at") || (args.every ? `Every ${args.every}s` : "");
			break;
		case "skill":
			value = text("name");
			break;
		case "bash":
			value = text("command");
			break;
		case "read":
			value = text("path") + (typeof args.offset === "number" ? ` · from line ${args.offset}` : "");
			break;
		case "write":
		case "edit":
			value = text("path");
			break;
		case "web_fetch":
		case "browser_navigate":
			value = text("url");
			break;
		case "browser_click":
			value = text("ref");
			break;
		case "browser_type":
			value = text("ref", "text") + (args.submit ? " · submit" : "");
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
		case "propose_send":
			value = text("ticket");
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
	return value ? shortPreview(value) : undefined;
}
