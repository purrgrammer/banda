/**
 * The agent's browser, live (DESIGN.md "The browser"): a small card in the chat while a run uses it, and the page
 * enlarged for reading and take-over. Nothing is drawn over the page the agent reads. Closing hands control back
 * before hiding it; when that cannot be confirmed, the window stays open with a retry.
 */
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BrowserWindow } from "../chat/Browser.tsx";
import { ViewCard } from "../chat/Cards.tsx";
import type { Who } from "../chat/types.ts";
import { BrowserScreen, type Frame } from "../components/BrowserScreen.tsx";
import { type BrowserView, browserEvents, browserInput, holdBrowser, stopChat } from "../lib/api.ts";
import { setBrowserOpen, useBrowserOpen } from "../lib/browser.ts";
import { BrowserSession } from "../lib/browser-session.ts";
import { browserOf, showBrowser, useShell } from "../lib/shell.ts";

/** Chat `chat`'s tab as the daemon says it, and its page as last drawn, while `active`. */
function useBrowserFeed(chat: number, active: boolean): { view: BrowserView | undefined; frame: Frame | undefined } {
	const view = browserOf(useShell(), chat);
	const [frame, setFrame] = useState<{ chat: number; frame: Frame }>();
	useEffect(() => {
		if (!active) return;
		const stop = new AbortController();
		void (async () => {
			for (let failures = 0; !stop.signal.aborted; failures++) {
				await browserEvents(
					chat,
					(event) => {
						if (stop.signal.aborted) return;
						if (event.type === "state") {
							if (!event.view.running) setFrame(undefined);
							showBrowser(chat, event.view);
						} else setFrame({ chat, frame: { data: event.data, width: event.width, height: event.height } });
					},
					stop.signal,
				).catch(() => {});
				if (!stop.signal.aborted)
					await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * 2 ** failures)));
			}
		})();
		return () => stop.abort();
	}, [active, chat]);
	return { view, frame: frame?.chat === chat ? frame.frame : undefined };
}

const hostOf = (url: string | undefined) => {
	try {
		return url === undefined ? "" : new URL(url).host;
	} catch {
		return url ?? "";
	}
};

/** The card in the chat while the agent's run uses its browser. */
export function LiveView({ chat, who }: { chat: number; who: Who }) {
	const enlarged = useBrowserOpen() === chat;
	const { view, frame } = useBrowserFeed(chat, !enlarged);
	return (
		<ViewCard
			host={hostOf(view?.url)}
			title={view?.title ?? "Its browser"}
			live={view?.running === true}
			screen={
				frame === undefined ? undefined : (
					<img
						src={`data:image/jpeg;base64,${frame.data}`}
						alt={`${view?.title ?? "The page"}, as ${who.name} sees it`}
						className="block h-full w-full object-cover object-top"
					/>
				)
			}
			onOpen={() => setBrowserOpen(chat)}
			onTakeOver={() => {
				setBrowserOpen(chat);
				void holdBrowser(chat, true).then(
					(next) => showBrowser(chat, next),
					() => {},
				);
			}}
		/>
	);
}

/** The browser enlarged, over the app, for whichever chat asked for it. */
export function BrowserDialog({ who }: { who: (chat: number) => Who }) {
	const chat = useBrowserOpen();
	const [why, setWhy] = useState<string | undefined>(undefined);
	const [stuck, setStuck] = useState(false);
	const feed = useBrowserFeed(chat ?? 0, chat !== undefined);
	// one session a chat opened: control is queued, and closing waits until a take-over is known given back
	const latest = useRef(feed.view);
	latest.current = feed.view;
	const [session, setSession] = useState<{ chat: number; session: BrowserSession }>();
	useEffect(() => {
		setWhy(undefined);
		if (chat === undefined) return setSession(undefined);
		setStuck(false);
		setSession({
			chat,
			session: new BrowserSession({
				current: () => latest.current,
				hold: (on) => holdBrowser(chat, on),
				show: (view) => showBrowser(chat, view),
				hide: () => setBrowserOpen(undefined),
			}),
		});
	}, [chat]);
	if (chat === undefined || session?.chat !== chat) return null;
	const agent = who(chat);
	const { view, frame } = feed;
	const owner = view?.control === "owner";
	const hold = (on: boolean) => {
		setWhy(undefined);
		session.session.control(on).then(
			() => setStuck(false),
			(failed: Error) => {
				setWhy(
					on
						? `The page wasn't handed to you: ${failed.message}`
						: `${agent.name} hasn't taken the page back: ${failed.message}`,
				);
				setStuck(!on);
			},
		);
	};
	const close = () => {
		setWhy(undefined);
		session.session.close().catch((failed: Error) => {
			setWhy(`${agent.name} hasn't taken the page back: ${failed.message}`);
			setStuck(true);
		});
	};
	return (
		<Dialog open onOpenChange={(open) => (open ? undefined : close())}>
			<DialogContent
				showCloseButton={false}
				className="max-w-[min(64rem,calc(100vw-2rem))] border-0 bg-transparent p-0 shadow-none sm:max-w-[min(64rem,calc(100vw-2rem))]"
			>
				<DialogTitle className="sr-only">{agent.name}'s browser</DialogTitle>
				<BrowserWindow
					agent={agent.name}
					host={hostOf(view?.url)}
					title={view?.title ?? "Its browser"}
					hold={stuck ? "stuck" : owner ? "owner" : "agent"}
					why={why}
					screen={
						<BrowserScreen
							name={agent.name}
							view={view}
							frame={frame}
							{...(owner ? { onInput: async (input) => void (await browserInput(chat, input)) } : {})}
						/>
					}
					onTakeOver={() => hold(true)}
					onGiveBack={() => hold(false)}
					onStop={() => void stopChat(chat)}
					onClose={() => close()}
				/>
			</DialogContent>
		</Dialog>
	);
}
