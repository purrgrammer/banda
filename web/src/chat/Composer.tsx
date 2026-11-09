/**
 * The composer, on ai-elements' prompt-input: words, files (photos, documents, video, dropped or pasted anywhere), a
 * voice message (transcribed here, sent as words with its audio), send. It is the same while the agent works: what is
 * sent then waits in the chat's queue, and stopping lives in the header. One quiet menu holds the rest. In a group it
 * says who a message goes to. Its draft, words and files, is kept per chat until it is sent.
 */
import { ArrowUpIcon, PaperclipIcon, Trash2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	Attachment,
	AttachmentInfo,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "@/components/ai-elements/attachments";
import {
	PromptInput,
	PromptInputActionAddAttachments,
	PromptInputActionMenu,
	PromptInputActionMenuContent,
	PromptInputActionMenuTrigger,
	PromptInputBody,
	PromptInputButton,
	PromptInputFooter,
	PromptInputHeader,
	PromptInputProvider,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputAttachments,
	usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import { SpeechInput } from "@/components/ai-elements/speech-input";
import type { FileUIPart } from "@/components/ai-elements/types";
import { cn } from "@/lib/cn";
import { slashQuery } from "../../../src/core/skill-tokens.ts";
import { localPreview, type Preview } from "../lib/api.ts";
import { readDraft, readDraftFiles, saveDraft, saveDraftFiles } from "../lib/drafts.ts";
import { mentionQuery } from "../lib/mentions.ts";
import { Face } from "./Face.tsx";
import type { SkillSummary } from "./Skill.tsx";
import type { Who } from "./types.ts";
import { Recording } from "./Voice.tsx";

const FINE_POINTER = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

export type ComposerState = "ready" | "recording";

export function Composer({
	to,
	draft,
	files = [],
	state = "ready",
	group = false,
	mentionables,
	skills,
	onSend,
	focus = false,
	className,
	keep,
}: {
	/** Who it goes to: "Mara", or a group's name. */
	to: string;
	draft?: string | undefined;
	/** The chat whose unsent words are kept on this device (`lib/drafts.ts`), so they survive leaving it and a reload. */
	keep?: string | undefined;
	/** Files shown attached (the specimen's; in use, those the owner adds). */
	files?: readonly (FileUIPart & { id: string })[];
	state?: ComposerState;
	/** In a group: "To everyone · @ to pick one". */
	group?: boolean;
	/** In a group: the members an @ offers, picked by name. */
	mentionables?: readonly Who[] | undefined;
	/** Available shared skills; omitted until the catalogue is wired. */
	skills?: readonly SkillSummary[] | undefined;
	/** Send the words and files as written; a rejection keeps the draft and says why. */
	onSend?: (text: string, files: readonly File[]) => Promise<void>;
	/** Take the focus as it opens, where there is a keyboard of its own (not a touch screen). */
	focus?: boolean;
	className?: string;
}) {
	const [refused, setRefused] = useState<string | undefined>(undefined);
	const root = useRef<HTMLDivElement>(null);
	return (
		<PromptInputProvider key={keep} initialInput={(keep === undefined ? undefined : readDraft(keep)) ?? draft ?? ""}>
			{keep === undefined ? null : <KeepDraft chat={keep} />}
			<div ref={root} className={cn("relative flex flex-col gap-1.5", className)}>
				{mentionables === undefined || mentionables.length === 0 ? null : <MentionPicker members={mentionables} />}
				{skills === undefined || skills.length === 0 ? null : <SkillPicker skills={skills} root={root} />}
				<PromptInput
					onSubmit={async (message) => {
						if (onSend === undefined) return;
						setRefused(undefined);
						try {
							const files = await Promise.all(message.files.map((part) => fileOf(part)));
							await onSend(message.text, files);
						} catch (failed) {
							// the words and files stay in the composer, and it says why they did not go
							setRefused(failed instanceof Error ? failed.message : String(failed));
							throw failed;
						}
					}}
					multiple
					globalDrop
					// one row (attach, the words, voice and send) with the attachments, when any, on a row of their own above
					className="rounded-tile bg-paper shadow-composer [&_[data-slot=input-group]]:flex-row [&_[data-slot=input-group]]:flex-wrap [&_[data-slot=input-group]]:items-end [&_[data-slot=input-group]]:rounded-tile [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:ring-0"
				>
					<Attached shown={files} />
					<PromptInputBody>
						{state === "recording" ? (
							<span className="flex min-w-0 flex-1 basis-0 px-1 py-2.5">
								<Recording elapsed="0:07" />
							</span>
						) : (
							<PromptInputTextarea
								placeholder={`Message ${to}`}
								// a chat opened is a chat to write in; on a touch screen the keyboard would cover it
								autoFocus={focus && FINE_POINTER}
								className="max-h-48 min-h-10 w-auto min-w-0 basis-0 px-1 py-2.5 text-body placeholder:text-ink-2"
							/>
						)}
					</PromptInputBody>
					<PromptInputFooter className="contents">
						<PromptInputTools className="-order-1 self-end py-1.5 pl-1.5">
							{state === "recording" ? (
								<PromptInputButton aria-label="Discard the recording" className="text-ink-2">
									<Trash2Icon className="size-4" />
								</PromptInputButton>
							) : (
								<PromptInputActionMenu>
									<PromptInputActionMenuTrigger aria-label="Add photos and files, and more" className="text-ink-2">
										<PaperclipIcon className="size-4" />
									</PromptInputActionMenuTrigger>
									<PromptInputActionMenuContent>
										<PromptInputActionAddAttachments label="Photos, files and video" />
									</PromptInputActionMenuContent>
								</PromptInputActionMenu>
							)}
						</PromptInputTools>
						<span className="order-last flex items-center gap-1 self-end py-1.5 pr-1.5">
							{state === "ready" ? (
								<SpeechInput variant="ghost" size="icon-sm" aria-label="Record a voice message" />
							) : null}
							<PromptInputSubmit className="rounded-full bg-ink text-paper hover:bg-ink/85" aria-label="Send">
								<ArrowUpIcon className="size-4" />
							</PromptInputSubmit>
						</span>
					</PromptInputFooter>
				</PromptInput>
				{refused === undefined ? null : (
					<p role="alert" className="px-3 text-meta text-danger">
						Not sent: {refused}
					</p>
				)}
				{group ? <GroupHint members={mentionables ?? []} /> : null}
			</div>
		</PromptInputProvider>
	);
}

/**
 * The draft as it stands, kept for the chat: its words, and its files, put back as the composer opens. Sent, the
 * composer empties and the draft goes with it.
 */
function KeepDraft({ chat }: { chat: string }) {
	const { textInput, attachments } = usePromptInputController();
	const text = textInput.value;
	useEffect(() => {
		saveDraft(chat, text);
	}, [chat, text]);
	// the files kept are put back before any is saved, so an empty composer opening never forgets them
	const [restored, setRestored] = useState(false);
	const add = useRef(attachments.add);
	add.current = attachments.add;
	useEffect(() => {
		let gone = false;
		void readDraftFiles(chat).then((files) => {
			if (gone) return;
			if (files.length > 0) add.current(files);
			setRestored(true);
		});
		return () => {
			gone = true;
		};
	}, [chat]);
	const parts = attachments.files;
	useEffect(() => {
		if (restored) void saveDraftFiles(chat, () => Promise.all(parts.map((part) => fileOf(part))));
	}, [restored, chat, parts]);
	return null;
}

/** Who a group message goes to as it stands: everyone, or the members it @mentions. */
function GroupHint({ members }: { members: readonly Who[] }) {
	const controller = usePromptInputController();
	const text = controller.textInput.value;
	const named = members.filter((member) =>
		new RegExp(`(^|\\s)@${member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text),
	);
	return (
		<p className="px-3 text-meta text-ink-2">
			{members.length === 0
				? "Nobody is in it yet · add agents from its panel"
				: named.length === 0
					? "To everyone · @ to pick one"
					: `To ${named.map((member) => member.name).join(" and ")}`}
		</p>
	);
}

/**
 * An attached file back as a File, for the upload. The composer hands it over as a data: URL (or a blob: one), and
 * the page's security policy lets nothing be fetched from data:, so it is decoded here instead.
 */
async function fileOf(part: FileUIPart): Promise<File> {
	const name = part.filename ?? "file";
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(part.url);
	if (match !== null) {
		const [, type = "", base64, body = ""] = match;
		const bytes =
			base64 === undefined
				? new TextEncoder().encode(decodeURIComponent(body))
				: Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
		return new File([bytes], name, { type: part.mediaType || type });
	}
	const blob = await (await fetch(part.url)).blob();
	return new File([blob], name, { type: part.mediaType || blob.type });
}

/**
 * The @ offer: while an @word is typed just before the caret, the members whose names start with it, above the
 * composer; Enter or Tab (or a tap) puts the first or the chosen one's name in, Esc closes it.
 */
function MentionPicker({ members }: { members: readonly Who[] }) {
	const { textInput } = usePromptInputController();
	const [, setMoved] = useState(0);
	const [active, setActive] = useState(0);
	const [closed, setClosed] = useState<string | undefined>(undefined);
	// the caret is read from the field itself, as the text is: a selectionchange arrives after the input that moved it,
	// so a caret kept from it lags fast typing (a pick kept the query typed; the next @ was missed)
	const field = () => document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
	const caretNow = () => {
		const at = field();
		return at === null || at.value !== textInput.value ? textInput.value.length : at.selectionStart;
	};
	const placing = useRef<number | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text changed, to place the caret a pick asked for
	useLayoutEffect(() => {
		const at = placing.current;
		const into = field();
		if (at === undefined || into === null || into.value !== textInput.value) return;
		placing.current = undefined;
		into.focus();
		into.setSelectionRange(at, at);
	}, [textInput.value]);
	useEffect(() => {
		// a caret moved without typing (arrows, a click) shows or hides the list
		const track = () => setMoved((n) => n + 1);
		document.addEventListener("selectionchange", track);
		return () => document.removeEventListener("selectionchange", track);
	}, []);
	const caret = caretNow();
	const query = mentionQuery(textInput.value, caret);
	const shown =
		query === undefined || closed === textInput.value
			? []
			: members.filter((member) => member.name.toLowerCase().startsWith(query.query.toLowerCase())).slice(0, 6);
	const pick = (member: Who) => {
		const now = caretNow();
		const found = mentionQuery(textInput.value, now);
		if (found === undefined) return;
		const before = textInput.value.slice(0, found.start);
		const after = textInput.value.slice(now);
		textInput.setInput(`${before}@${member.name} ${after.replace(/^\s/, "")}`);
		setActive(0);
		// the caret goes after the name as soon as the new text is in the field, before the next key is read
		placing.current = before.length + member.name.length + 2;
	};
	useEffect(() => {
		if (shown.length === 0) return;
		const keys = (event: KeyboardEvent) => {
			if (!(event.target instanceof HTMLTextAreaElement) || event.target.name !== "message") return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setActive((was) => (was + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
			} else if (event.key === "Enter" || event.key === "Tab") {
				const member = shown[Math.min(active, shown.length - 1)];
				if (member === undefined) return;
				event.preventDefault();
				event.stopPropagation();
				pick(member);
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setClosed(textInput.value);
			}
		};
		document.addEventListener("keydown", keys, true);
		return () => document.removeEventListener("keydown", keys, true);
	});
	if (shown.length === 0) return null;
	return (
		<div
			role="listbox"
			aria-label="Mention an agent"
			className="absolute bottom-full left-2 z-10 mb-1.5 flex min-w-48 flex-col rounded-tile border border-line bg-paper p-1 shadow-composer"
		>
			{shown.map((member, index) => (
				<button
					key={member.name}
					type="button"
					role="option"
					aria-selected={index === Math.min(active, shown.length - 1)}
					onMouseDown={(event) => {
						event.preventDefault();
						pick(member);
					}}
					className={cn(
						"flex items-center gap-2.5 rounded-field px-2 py-1.5 text-left text-ui text-ink",
						index === Math.min(active, shown.length - 1) && "bg-paper-3",
					)}
				>
					<Face face={member.face} name={member.name} size="message" />
					{member.name}
				</button>
			))}
		</div>
	);
}

/** The / offer: complete names, with descriptions, while the caret is in an unquoted slash token. */
function SkillPicker({
	skills,
	root,
}: {
	skills: readonly SkillSummary[];
	root: React.RefObject<HTMLDivElement | null>;
}) {
	const { textInput } = usePromptInputController();
	const [active, setActive] = useState(0);
	const [closed, setClosed] = useState<string | undefined>(undefined);
	const [, setMoved] = useState(0);
	const placing = useRef<number | undefined>(undefined);
	const field = () => root.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
	const caretNow = () => {
		const at = field();
		return at == null || at.value !== textInput.value ? textInput.value.length : at.selectionStart;
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: a pick sets the caret after the new text is in the field
	useLayoutEffect(() => {
		const at = placing.current;
		const into = field();
		if (at === undefined || into == null || into.value !== textInput.value) return;
		placing.current = undefined;
		into.focus();
		into.setSelectionRange(at, at);
	}, [textInput.value]);
	useEffect(() => {
		const track = () => setMoved((n) => n + 1);
		document.addEventListener("selectionchange", track);
		return () => document.removeEventListener("selectionchange", track);
	}, []);
	const query = slashQuery(textInput.value, caretNow());
	const shown =
		query === undefined || closed === textInput.value || document.activeElement !== field()
			? []
			: skills
					// every match: the ones the name starts with first, then by name; the list scrolls
					.filter((skill) => skill.name.includes(query.query))
					.sort(
						(a, b) =>
							Number(b.name.startsWith(query.query)) - Number(a.name.startsWith(query.query)) ||
							a.name.localeCompare(b.name),
					);
	const list = useRef<HTMLDivElement>(null);
	const current = Math.min(active, shown.length - 1);
	useEffect(() => {
		list.current?.querySelector(`[data-option="${current}"]`)?.scrollIntoView({ block: "nearest" });
	}, [current]);
	const pick = (name: string) => {
		const found = slashQuery(textInput.value, caretNow());
		if (found === undefined) return;
		const before = textInput.value.slice(0, found.start);
		const after = textInput.value.slice(found.end).replace(/^\s/, "");
		textInput.setInput(`${before}/${name} ${after}`);
		placing.current = before.length + name.length + 2;
		setActive(0);
	};
	useEffect(() => {
		if (shown.length === 0) return;
		const keys = (event: KeyboardEvent) => {
			if (event.target !== field() || event.isComposing) return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setActive((was) => (was + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
			} else if (event.key === "Enter" || event.key === "Tab") {
				const skill = shown[Math.min(active, shown.length - 1)];
				if (skill === undefined) return;
				event.preventDefault();
				event.stopPropagation();
				pick(skill.name);
			} else if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setClosed(textInput.value);
			}
		};
		document.addEventListener("keydown", keys, true);
		return () => document.removeEventListener("keydown", keys, true);
	});
	if (shown.length === 0) return null;
	return (
		<div
			ref={list}
			role="listbox"
			aria-label="Choose a skill"
			className="absolute bottom-full left-2 z-10 mb-1.5 flex w-[min(26rem,calc(100%-1rem))] max-h-[min(24rem,50dvh)] flex-col overflow-y-auto rounded-tile border border-line bg-paper p-1 shadow-composer"
		>
			{shown.map((skill, index) => (
				<button
					key={skill.name}
					type="button"
					role="option"
					data-option={index}
					aria-selected={index === current}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => pick(skill.name)}
					className={cn(
						"flex min-w-0 flex-col gap-0.5 rounded-field px-2.5 py-2 text-left",
						index === current && "bg-paper-3",
					)}
				>
					<span className="font-mono text-ui text-ink">/{skill.name}</span>
					<span className="line-clamp-2 text-meta text-ink-2">{skill.description}</span>
				</button>
			))}
		</div>
	);
}

/** What the daemon drew of each file attached, by its id: drawn once, while it stays attached. */
const glimpses = new Map<string, Promise<string | undefined>>();

/** A preview in a few words, beside the file's name: "PDF, 12 pages", "Sheet, 40 rows", its first line. */
export function glimpseWords(preview: Preview): string | undefined {
	switch (preview.kind) {
		case "pdf":
			return preview.pages === 0 ? "PDF" : `PDF, ${preview.pages === 1 ? "1 page" : `${preview.pages} pages`}`;
		case "sheet":
			return `Sheet, ${Math.max(0, preview.total - 1).toLocaleString()} rows`;
		case "text":
			return preview.language === undefined
				? preview.lines.find((line) => line.trim() !== "")?.trim()
				: `${preview.total.toLocaleString()} lines`;
		case "document":
			return preview.lines[0];
		default:
			return undefined;
	}
}

/**
 * A file attached, as the daemon draws it before it is sent (its bytes go to `POST /api/previews`, nothing is kept): a
 * PDF's pages, a sheet's rows, a document's first line. An image shows itself; a file the daemon cannot read has none.
 */
function Glimpse({ part }: { part: FileUIPart & { id: string } }) {
	const [words, setWords] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (part.mediaType.startsWith("image/")) return;
		let gone = false;
		let drawn = glimpses.get(part.id);
		if (drawn === undefined) {
			drawn = fileOf(part)
				.then((file) => localPreview(file))
				.then(glimpseWords, () => undefined);
			glimpses.set(part.id, drawn);
		}
		void drawn.then((said) => {
			if (!gone) setWords(said);
		});
		return () => {
			gone = true;
		};
	}, [part]);
	if (words === undefined) return null;
	return <span className="max-w-40 truncate text-meta text-ink-2">{words}</span>;
}

/** The files attached: those the owner added, and any shown. */
function Attached({ shown }: { shown: readonly (FileUIPart & { id: string })[] }) {
	const { files, remove } = usePromptInputAttachments();
	const all = [...shown, ...files];
	// the row shows only with something in it: attached here, or given
	if (all.length === 0) return null;
	return (
		<PromptInputHeader>
			<Attachments variant="inline" className="px-1 pt-1">
				{all.map((file) => (
					<Attachment
						key={file.id}
						data={file}
						data-attachment={file.filename}
						onRemove={() => remove(file.id)}
						className="max-w-full"
					>
						<AttachmentPreview />
						<AttachmentInfo />
						<Glimpse part={file} />
						<AttachmentRemove />
					</Attachment>
				))}
			</Attachments>
		</PromptInputHeader>
	);
}
