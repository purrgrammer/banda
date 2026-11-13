/**
 * The page's showcase: short chats drawn by the app's own components, with the specimen's invented data, each in a
 * `[data-showcase]` placeholder of index.html. Each draws in a shadow root holding the app's stylesheet, so neither the
 * page's styles nor the app's reach the other. A showcase is a picture of the app, not the app: it is inert, and its
 * placeholder says in words what it shows.
 */
import { CalendarClockIcon, EyeIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { HarnessAsks } from "@/app/HarnessSession.tsx";
import { ApprovalCard } from "@/chat/Approval.tsx";
import { Band } from "@/chat/Band.tsx";
import { ViewCard } from "@/chat/Cards.tsx";
import { Bubble, DaySeparator, Mention, Run } from "@/chat/Feed.tsx";
import { HarnessCard } from "@/chat/Harness.tsx";
import { Line } from "@/chat/Line.tsx";
import { EventCard, MessagesCard, ObjectLink, PullRequestCard } from "@/chat/Object.tsx";
import { Named, WatchLine } from "@/chat/Watch.tsx";
import { WorkingLine } from "@/chat/WorkingLine.tsx";
import { watchWords } from "@/lib/chat.ts";
import { PLANNING } from "@/specimen/connections/calendar.tsx";
import { SLACK_THREAD } from "@/specimen/connections/slack.tsx";
import { ATLAS, MARA, OTTO, PAGE, PR, ROWS, SANCHO } from "@/specimen/fixtures.ts";
import { askSession, EXECUTE_ASK, sessionAt } from "@/specimen/harness/harness.tsx";
import { ChatScreen } from "@/specimen/screens/screens.tsx";
import { StageContext } from "@/specimen/stage.tsx";
import css from "./showcase.css?inline";

/** The specimen's thread, down to what Otto's answer rests on: the post, Ana's approval and the deploy. */
const SHIP_THREAD = {
	...SLACK_THREAD,
	total: 3,
	messages: SLACK_THREAD.messages.filter((message) =>
		["1700000500.000600", "1700000200.000300", "1700000000.000100"].includes(message.id),
	),
};

const FOLLOWED = "purrgrammer/banda #34";
const followed = (
	<Named>
		<ObjectLink object={{ ...PR, card: "pull-request" }} href={PR.url ?? ""} />
	</Named>
);

const PHONE = "(max-width: 720px)";
const onWidth = (change: () => void) => {
	const query = matchMedia(PHONE);
	query.addEventListener("change", change);
	return () => query.removeEventListener("change", change);
};

/** The app as it opens on a group: the band beside the chat, or on a phone the chat alone. */
function App() {
	const phone = useSyncExternalStore(onWidth, () => matchMedia(PHONE).matches);
	const frame = useRef<HTMLDivElement>(null);
	// a chat opens at its latest message, as the app's does
	useLayoutEffect(() => {
		for (const feed of frame.current?.querySelectorAll(".overflow-y-auto") ?? []) feed.scrollTop = feed.scrollHeight;
	});
	return (
		<StageContext.Provider value={{ scheme: "both", width: phone ? "phone" : "desktop" }}>
			<div ref={frame} className="flex h-full min-h-0 bg-paper">
				{phone ? null : <Band rows={ROWS} selected="trip" />}
				<ChatScreen name="Trip" faces={[SANCHO, MARA]} group>
					<Run time="9:50">
						<Bubble>Can we do Lisbon the weekend of the 14th? Check my calendar and flights.</Bubble>
					</Run>
					<Run who={SANCHO} time="9:51" compact={false}>
						<Bubble>Your calendar is free Friday from noon and all weekend.</Bubble>
					</Run>
					<Run who={MARA} time="9:53" compact={false}>
						<Bubble>
							Then Friday morning flights work. <Mention who={SANCHO} />, can you block Friday afternoon?
						</Bubble>
					</Run>
					<Run who={SANCHO} time="9:58" compact={false}>
						<Bubble>Saturday works for both. Blocked Friday 12:00 to 18:00.</Bubble>
					</Run>
					<Run time="10:05">
						<Bubble>
							<Mention who={MARA} /> book the 9:15. <Mention who={SANCHO} /> add it to my calendar.
						</Bubble>
					</Run>
					<WorkingLine who={[MARA, SANCHO]} onOpen={() => {}} />
				</ChatScreen>
			</div>
		</StageContext.Provider>
	);
}

const SHOWCASES: Readonly<Record<string, () => ReactNode>> = {
	app: () => <App />,
	computer: () => (
		<>
			<Run time="09:30">
				<Bubble>Find me a train from Porto to Lisbon on Friday morning.</Bubble>
			</Run>
			<Run who={MARA} time="09:31">
				<Bubble>Looking at the timetables now. You can watch, or take over.</Bubble>
				<ViewCard host="trains.example" title="Porto to Lisbon, Fri 14 Nov" shot={PAGE} />
			</Run>
		</>
	),
	routine: () => (
		<>
			<DaySeparator>Yesterday</DaySeparator>
			<Run time="18:10">
				<Bubble>Every weekday at 8, tell me what's on my plate.</Bubble>
			</Run>
			<Line icon={CalendarClockIcon}>Morning brief set up · weekdays at 08:00</Line>
			<DaySeparator>Today</DaySeparator>
			<Line icon={CalendarClockIcon} time="08:00">
				Morning brief ran
			</Line>
			<Run who={ATLAS} time="08:00">
				<Bubble>
					Planning with Northstar at 10:00, then a 1:1 with Ana at 15:00. The launch checklist is due Friday.
				</Bubble>
			</Run>
		</>
	),
	github: () => (
		<>
			<Run time="09:12">
				<Bubble>Is the terminology pull request ready?</Bubble>
			</Run>
			<Run who={SANCHO} time="09:12">
				<Bubble>It is. All 11 checks pass and Octo approved it.</Bubble>
				<PullRequestCard pr={PR} />
			</Run>
		</>
	),
	mcp: () => (
		<>
			<Run time="11:05">
				<Bubble>File an issue for the flaky auth test.</Bubble>
			</Run>
			<Run who={OTTO} time="11:05">
				<ApprovalCard
					agent="Otto"
					what="Use Linear's create_issue"
					verb="Create"
					as="bandarra@example.com on Linear"
					text={
						"Flaky: auth test fails on main\n\nFails about one run in five since the token refresh change. Seen on deploys 40 and 41."
					}
				/>
			</Run>
		</>
	),
	calendar: () => (
		<>
			<Run time="18:02">
				<Bubble>What's on Monday?</Bubble>
			</Run>
			<Run who={ATLAS} time="18:02">
				<Bubble>
					Quarterly planning with Northstar, at their office. There's a call link if you'd rather join from home.
				</Bubble>
				<EventCard event={PLANNING} />
			</Run>
		</>
	),
	slack: () => (
		<>
			<Run time="10:45">
				<Bubble>Can we ship on Thursday?</Bubble>
			</Run>
			<Run who={OTTO} time="10:45">
				<Bubble>Looks like it. Ana is happy, v41 is tagged and deploy 41 finished healthy.</Bubble>
				<MessagesCard list={SHIP_THREAD} />
			</Run>
		</>
	),
	watch: () => (
		<>
			<DaySeparator>Yesterday</DaySeparator>
			<Run time="16:20">
				<Bubble>
					Keep an eye on the terminology pull request. Tell me when it's approved or a check fails, and if Ana asks for
					changes, what she wants.
				</Bubble>
			</Run>
			{/* the app draws a proposal you accepted as this line, in its place */}
			<Line icon={EyeIcon}>Mara followed {followed}</Line>
			<DaySeparator>Today</DaySeparator>
			<WatchLine
				name={FOLLOWED}
				object={followed}
				time="10:02"
				text={watchWords({
					object: { key: "", ref: "", connection: "", service: "", name: FOLLOWED },
					changes: ["ana requested changes", "bob commented"],
				})}
			/>
			<Run who={MARA} time="10:02">
				<Bubble>Ana asked for changes: keep the old words as aliases for one release. Bob agrees.</Bubble>
			</Run>
		</>
	),
	"coding-agent": () => (
		<>
			<Run time="10:40">
				<Bubble>The auth test is failing on main again. Can you get Claude Code to fix it?</Bubble>
			</Run>
			<Run who={MARA} time="10:41">
				<Bubble>I've asked Claude Code to fix it in your sancho folder. It wants to run the test first.</Bubble>
				<HarnessCard
					session={sessionAt("waiting", [])}
					permissions={<HarnessAsks session={askSession([EXECUTE_ASK])} />}
				/>
			</Run>
		</>
	),
};

/**
 * Some rules hold only at the document: a shadow root ignores `@property` and `@font-face`. Those join the page once;
 * the rest is each shadow root's, with the tokens the app keeps on `:root` kept on the root's host instead.
 */
function stylesheet(): CSSStyleSheet {
	const documentWide = /@(?:property|font-face)\s*[^{]*\{[^}]*\}/g;
	const page = document.createElement("style");
	page.textContent = (css.match(documentWide) ?? []).join("\n");
	document.head.append(page);
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(css.replace(documentWide, "").replaceAll(":root", ":host"));
	return sheet;
}

export function mountShowcases(placeholders: Iterable<HTMLElement>): void {
	const sheet = stylesheet();
	for (const placeholder of placeholders) {
		const draw = SHOWCASES[placeholder.dataset.showcase ?? ""];
		if (draw === undefined || placeholder.shadowRoot) continue;
		const shadow = placeholder.attachShadow({ mode: "open" });
		shadow.adoptedStyleSheets = [sheet];
		const host = document.createElement("div");
		host.inert = true;
		// inherited properties cross into a shadow root: the hero's centred text must not
		host.className = "flex h-full flex-col gap-3 bg-transparent text-start font-sans text-ink antialiased";
		shadow.append(host);
		createRoot(host).render(draw());
	}
}
