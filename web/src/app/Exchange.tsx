/**
 * What two agents said to each other (DESIGN.md "Agents and groups"): the messages they sent one another, in order,
 * as a chat the owner only reads. It opens from either agent's chat, from the line that says a message went between
 * them, at that message: scrolled to it and marked for a moment. There is no composer: only the two write here.
 */
import { ChevronLeftIcon, MessageCircleIcon, MessagesSquareIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FaceStack } from "../chat/Face.tsx";
import { Bubble, DaySeparator, Run } from "../chat/Feed.tsx";
import { PaneHeader } from "../chat/Header.tsx";
import { Line } from "../chat/Line.tsx";
import { ChatLoading } from "../chat/Loading.tsx";
import type { Who } from "../chat/types.ts";
import { Markdown } from "../components/Markdown.tsx";
import { type ExchangeMessage, exchange, Refused, Unauthorized } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { day, dayLabel, time } from "./Feed.tsx";

export type Pair = readonly [Who & { readonly id: string }, Who & { readonly id: string }];

/** How long the message it opened at stays marked. */
const MARK_MS = 1600;

/** Two agents' names as one title: "Mara and Atlas". */
export const pairTitle = (pair: Pair) => `${pair[0].name} and ${pair[1].name}`;

/**
 * The messages, oldest first, each under its sender's face and name, with day separators; "Earlier messages" when
 * older pages remain; the one it opened at (`focus`, by the call that sent it) scrolled to and marked, once it is in.
 */
export function ExchangeFeed({
	pair,
	items,
	loaded,
	older = false,
	onOlder,
	focus,
	onMissing,
}: {
	pair: Pair;
	items: readonly ExchangeMessage[];
	loaded: boolean;
	older?: boolean;
	onOlder?: (() => Promise<void>) | undefined;
	/** The call whose message it opened at. */
	focus?: string | undefined;
	/** The message it opened at is not here, every page read. */
	onMissing?: (() => void) | undefined;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const found = useRef<string | undefined>(undefined);
	const whoOf = (id: string) => pair.find((who) => who.id === id) ?? { id, name: id, face: pair[0].face };
	// the newest, as a chat opens, unless it opened at a message
	const followed = useRef(false);
	useLayoutEffect(() => {
		if (!loaded || followed.current || focus !== undefined) return;
		followed.current = true;
		const box = scroller.current;
		if (box !== null) box.scrollTop = box.scrollHeight;
	}, [loaded, focus]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `items` is what the message may have arrived in: each page read looks again
	useEffect(() => {
		if (!loaded || focus === undefined || found.current === focus) return;
		const target = scroller.current?.querySelector<HTMLElement>(`[data-call="${CSS.escape(focus)}"]`) ?? null;
		if (target === null) {
			if (older && onOlder !== undefined) void attempt("load earlier messages", onOlder);
			else onMissing?.();
			return;
		}
		found.current = focus;
		target.scrollIntoView({ block: "center" });
		target.setAttribute("data-found", "");
		const timer = setTimeout(() => target.removeAttribute("data-found"), MARK_MS);
		return () => {
			clearTimeout(timer);
			target.removeAttribute("data-found");
		};
	}, [loaded, focus, items, older, onOlder, onMissing]);
	const nodes: ReactNode[] = [];
	let lastDay: string | undefined;
	for (const item of items) {
		if (day(item.at) !== lastDay) {
			lastDay = day(item.at);
			nodes.push(<DaySeparator key={`day-${item.chat}-${item.entry}`}>{dayLabel(item.at)}</DaySeparator>);
		}
		const who = whoOf(item.from);
		nodes.push(
			<div
				key={`${item.chat}-${item.entry}`}
				data-entry={item.entry}
				data-call={item.call}
				className="scroll-my-24 rounded-tile transition-[background-color] duration-700 data-[found]:bg-paper-3 motion-reduce:transition-none"
			>
				<Run who={who} time={time(item.at)}>
					<Bubble copy={item.text}>
						<Markdown>{item.text}</Markdown>
					</Bubble>
				</Run>
			</div>,
		);
	}
	return (
		<div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[44rem] flex-col gap-3 px-4 pt-4 pb-6">
				{older && onOlder !== undefined ? (
					<button
						type="button"
						className="self-center text-meta text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
						onClick={() => void attempt("load earlier messages", onOlder)}
					>
						Earlier messages
					</button>
				) : null}
				{loaded ? null : <ChatLoading />}
				{/* only once every page was read: a long chat of other work gives an empty page with more behind it */}
				{loaded && items.length === 0 && !older ? (
					<Line icon={MessageCircleIcon}>
						{pair[0].name} and {pair[1].name} haven't messaged each other yet.
					</Line>
				) : null}
				{nodes}
			</div>
		</div>
	);
}

/** The exchange's title bar: both faces, both names, that the owner only reads here, and the way back to the chat. */
export function ExchangeHeader({ pair, phone, onBack }: { pair: Pair; phone: boolean; onBack: () => void }) {
	return (
		<PaneHeader
			title={pairTitle(pair)}
			icon={<FaceStack faces={pair} name={pairTitle(pair)} size="message" />}
			phone={phone}
			detail={<p className="truncate text-meta text-ink-2">What they sent each other. Only they write here.</p>}
			navigation={
				// as an artifact's page: back to the chat it opened from, at either width
				<Button variant="ghost" size="icon-sm" aria-label="Back to the chat" className="text-ink-2" onClick={onBack}>
					<ChevronLeftIcon className="size-5" />
				</Button>
			}
		/>
	);
}

/** The whole screen, given its data: what the specimen shows and the page fills. */
export function ExchangeScreen(
	props: Parameters<typeof ExchangeFeed>[0] & { phone: boolean; onBack: () => void; notice?: string | undefined },
) {
	const { phone, onBack, notice, ...feed } = props;
	return (
		<div className="flex min-w-0 flex-1 flex-col bg-paper">
			<ExchangeHeader pair={feed.pair} phone={phone} onBack={onBack} />
			{notice === undefined ? null : (
				<Line icon={MessagesSquareIcon} className="pt-3">
					{notice}
				</Line>
			)}
			<ExchangeFeed {...feed} />
		</div>
	);
}

const key = (item: ExchangeMessage) => `${item.chat}:${item.entry}`;

/** The exchange between agents `a` and `b`, read from the daemon page by page. */
export function ExchangePage({
	pair,
	call,
	phone,
	onBack,
	gone,
}: {
	pair: Pair;
	call?: string | undefined;
	phone: boolean;
	onBack: () => void;
	/** What to show when the daemon knows no such pair: one of them is no agent of this band. */
	gone: ReactNode;
}) {
	const [items, setItems] = useState<readonly ExchangeMessage[]>([]);
	const [next, setNext] = useState<string>();
	const [loaded, setLoaded] = useState(false);
	/** The call said to be missing: a notice for that call alone, so another call opened at needs no reset. */
	const [missing, setMissing] = useState<string>();
	const [failed, setFailed] = useState<Error>();
	const [noPair, setNoPair] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [a, b] = [pair[0].id, pair[1].id];
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` counts the reads asked for; each reads again
	useEffect(() => {
		let left = false;
		setItems([]);
		setNext(undefined);
		setLoaded(false);
		setFailed(undefined);
		setNoPair(false);
		exchange(a, b).then(
			(page) => {
				if (left) return;
				setItems(page.items);
				setNext(page.next);
				setLoaded(true);
			},
			(error: unknown) => {
				if (left || error instanceof Unauthorized) return;
				if (error instanceof Refused && error.status === 404) setNoPair(true);
				else setFailed(error instanceof Error ? error : new Error(String(error)));
			},
		);
		return () => {
			left = true;
		};
	}, [a, b, attempt]);
	// opened at another message while the pair was gone (an agent restored since, say): read again
	const wasGone = useRef(false);
	wasGone.current = noPair;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `call` changing is what asks for the read again
	useEffect(() => {
		if (wasGone.current) setAttempt((n) => n + 1);
	}, [call]);
	const loadOlder = useCallback(async () => {
		if (next === undefined) return;
		const page = await exchange(a, b, next);
		setItems((now) => {
			const byKey = new Map(now.map((item) => [key(item), item]));
			for (const item of page.items) byKey.set(key(item), item);
			return [...byKey.values()].sort((x, y) => x.at - y.at || x.chat - y.chat || x.entry - y.entry);
		});
		setNext(page.next);
	}, [a, b, next]);
	const onMissing = useCallback(() => setMissing(call), [call]);
	const notice = useMemo(() => {
		if (failed !== undefined) return `Couldn't read these messages: ${failed.message}`;
		if (missing !== undefined && missing === call) return "The message this opened at isn't here.";
		return undefined;
	}, [failed, missing, call]);
	if (noPair) return gone;
	return (
		<ExchangeScreen
			pair={pair}
			items={items}
			loaded={loaded}
			older={next !== undefined}
			onOlder={loadOlder}
			focus={call}
			onMissing={onMissing}
			phone={phone}
			onBack={onBack}
			notice={notice}
		/>
	);
}
