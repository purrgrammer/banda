/**
 * The companion's browser, live (DESIGN.md "The app", a view; "The box", The browser): the page as its screencast
 * draws it. The owner watches while the companion works, and takes control (the panel around it, `BrowserPanel.tsx`,
 * holds the buttons): then their pointer and keys go to the page (and the companion's are refused) until they give it
 * back. Nothing is ever drawn over the page. On a phone, where a tap
 * opens no keyboard, a field types into the page. What the owner types goes to the page alone, never to the companion;
 * a session they sign in to stays in the companion's browser, which the panel says plainly. Filling its place (`fill`),
 * the page is drawn as large as fits, keeping its shape; a pointer on the bars beside it is not on the page.
 */
import { ArrowLeftIcon, CornerDownLeftIcon, DeleteIcon, MonitorIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type PointerEvent, useRef, useState, type WheelEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BrowserView, OwnerInput } from "../lib/api.ts";
import { pageAt } from "../lib/browser.ts";

export type Frame = { readonly data: string; readonly width: number; readonly height: number };

/** Keys the page gets as keys; any other single character is text. */
const KEYS = new Set([
	"Enter",
	"Backspace",
	"Tab",
	"Escape",
	"Delete",
	"ArrowLeft",
	"ArrowUp",
	"ArrowRight",
	"ArrowDown",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

/** A page's address as a person reads it: its host, or nothing for a blank page. */
export function siteOf(url: string | undefined): string | undefined {
	if (url === undefined || url === "about:blank") return undefined;
	try {
		return new URL(url).host || undefined;
	} catch {
		return undefined;
	}
}

/** Where a page is as a person reads it: its host and path (example.com/checkout), or nothing for a blank page. */
export function placeOf(url: string | undefined): string | undefined {
	const site = siteOf(url);
	if (site === undefined || url === undefined) return undefined;
	const path = new URL(url).pathname;
	return path === "/" ? site : `${site}${path}`;
}

export function BrowserScreen({
	name = "Your companion",
	view,
	frame,
	onInput,
	refused,
	fill = false,
}: {
	name?: string | undefined;
	view: BrowserView | undefined;
	/** The page as last drawn. */
	frame?: Frame | undefined;
	/** The owner's input, sent in order; rejects with why. */
	onInput?: (input: OwnerInput) => Promise<void>;
	/** A refusal to show from the start: the specimen's. */
	refused?: string;
	/** Take the height it is given (a panel), the page as large as fits in it; otherwise as tall as the page's shape. */
	fill?: boolean;
}) {
	const [error, setError] = useState(refused);
	const [typed, setTyped] = useState("");
	const [address, setAddress] = useState<string>();
	const queue = useRef<Promise<void>>(Promise.resolve());
	const lastMove = useRef(0);
	/** A press on the page is held: its drag and its release count wherever the pointer goes. */
	const pressed = useRef(false);
	const holding = view?.control === "owner" && onInput !== undefined;
	const running = view?.running === true;

	const send = (input: OwnerInput) => {
		if (onInput === undefined || !holding) return;
		// one after another, as the owner did them
		queue.current = queue.current
			.then(() => onInput(input))
			.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
	};
	/** Where on the page a pointer is, in the page's own pixels; undefined on the bars beside it, unless `clamp`. */
	const at = (event: PointerEvent<HTMLElement> | WheelEvent<HTMLElement>, clamp = false) =>
		pageAt(
			{ x: event.clientX, y: event.clientY },
			event.currentTarget.getBoundingClientRect(),
			{ width: frame?.width ?? 1280, height: frame?.height ?? 800 },
			clamp,
		);
	const pointer = (action: "down" | "up" | "move") => (event: PointerEvent<HTMLElement>) => {
		if (!holding) return;
		if (action === "down") event.currentTarget.focus();
		const where = at(event, pressed.current);
		if (where === undefined) return;
		if (action === "move") {
			// a hover is worth a few a second; a drag, every one
			const now = performance.now();
			if (event.buttons === 0 && now - lastMove.current < 80) return;
			lastMove.current = now;
		}
		if (action === "down") {
			pressed.current = true;
			// the release comes here even off the panel, so the page never keeps a button down
			event.currentTarget.setPointerCapture?.(event.pointerId);
		}
		if (action === "up") pressed.current = false;
		const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
		send({ type: "mouse", action, ...where, ...(action === "move" ? {} : { button }) });
	};
	const key = (event: KeyboardEvent<HTMLElement>) => {
		if (!holding) return;
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return; // the paste brings it as text
		if (KEYS.has(event.key)) {
			event.preventDefault();
			send({ type: "key", key: event.key });
		} else if ([...event.key].length === 1 && !event.metaKey && !event.ctrlKey) {
			event.preventDefault();
			send({ type: "text", text: event.key });
		}
	};
	const typeInto = (event: FormEvent) => {
		event.preventDefault();
		if (typed !== "") send({ type: "text", text: typed });
		setTyped("");
	};
	const go = (event: FormEvent) => {
		event.preventDefault();
		if (address !== undefined && address.trim() !== "") send({ type: "navigate", url: address.trim() });
		setAddress(undefined);
	};

	return (
		<div className={`flex min-h-0 flex-col gap-3 ${fill ? "flex-1" : ""}`}>
			{holding ? (
				<form className="flex items-center gap-2" onSubmit={go}>
					<Button type="button" variant="ghost" size="icon-sm" aria-label="Back" onClick={() => send({ type: "back" })}>
						<ArrowLeftIcon />
					</Button>
					<Input
						aria-label="Address"
						value={address ?? ""}
						placeholder={view?.url === undefined || view.url === "about:blank" ? "Go to an address" : view.url}
						onChange={(event) => setAddress(event.target.value)}
						className="h-8 font-mono text-xs"
						inputMode="url"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
					/>
				</form>
			) : null}
			<div
				role="application"
				aria-roledescription="remote page"
				aria-label={running ? `The page in ${name}'s browser` : `${name}'s browser is closed`}
				tabIndex={holding ? 0 : -1}
				onPointerDown={pointer("down")}
				onPointerUp={pointer("up")}
				onPointerMove={pointer("move")}
				onPointerCancel={() => {
					pressed.current = false;
				}}
				onWheel={(event) => {
					const where = holding ? at(event) : undefined;
					if (where !== undefined)
						send({ type: "mouse", action: "wheel", ...where, deltaX: event.deltaX, deltaY: event.deltaY });
				}}
				onKeyDown={key}
				onPaste={(event) => {
					const text = event.clipboardData.getData("text");
					if (holding && text !== "") {
						event.preventDefault();
						send({ type: "text", text });
					}
				}}
				onContextMenu={(event) => {
					if (holding) event.preventDefault();
				}}
				style={fill ? undefined : { aspectRatio: `${frame?.width ?? 1280} / ${frame?.height ?? 800}` }}
				className={`relative w-full touch-none overflow-hidden rounded-block bg-sa-surface outline-none ${
					fill ? "min-h-48 flex-1" : ""
				} ${
					holding
						? "cursor-default shadow-[0_0_0_2px_var(--sa-accent)] focus-visible:shadow-[0_0_0_3px_var(--sa-accent)]"
						: "shadow-[inset_0_0_0_1px_var(--sa-border)]"
				}`}
			>
				{frame === undefined ? (
					<div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-sa-muted">
						<MonitorIcon aria-hidden="true" className="size-6" />
						{running ? "Waiting for the page…" : "Nothing open"}
					</div>
				) : (
					<img
						alt=""
						draggable={false}
						src={`data:image/jpeg;base64,${frame.data}`}
						className="pointer-events-none absolute inset-0 size-full select-none object-contain"
					/>
				)}
			</div>
			{holding ? (
				<form className="flex items-center gap-2" onSubmit={typeInto}>
					<Input
						aria-label="Type into the page"
						placeholder="Type into the page"
						value={typed}
						onChange={(event) => setTyped(event.target.value)}
						autoCapitalize="off"
						autoCorrect="off"
						autoComplete="off"
						spellCheck={false}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Delete"
						onClick={() => send({ type: "key", key: "Backspace" })}
					>
						<DeleteIcon />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Enter"
						onClick={() => send({ type: "key", key: "Enter" })}
					>
						<CornerDownLeftIcon />
					</Button>
				</form>
			) : null}
			{error === undefined ? null : (
				<p role="alert" className="text-sm text-sa-error">
					{error}
				</p>
			)}
			{holding ? (
				<p className="text-xs text-sa-muted">
					What you type here goes to the page, never to {name}. If you sign in, the session stays in {name}'s browser: a
					credential you hand over for that site, which {name} can use as you until you sign it out from what it can
					use.
				</p>
			) : null}
		</div>
	);
}
