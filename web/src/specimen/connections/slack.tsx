/**
 * Slack: a thread, a channel, a direct message, a search and people as cards; authors from another team and bots; a post
 * and a reply as drafts on the floor; the access to choose before connecting; Slack named in the owner's words; and a
 * followed thread and channel: their watch rows (looking, behind while it reads a page a look, paused) and what Follow
 * on a channel says.
 */
import { useState } from "react";
import { DraftApproval } from "../../app/DraftApproval.tsx";
import { ConnectionPermissions } from "../../chat/Connect.tsx";
import { ConnectionIcon } from "../../chat/ConnectionIcon.tsx";
import { Bubble } from "../../chat/Feed.tsx";
import { ContactCard, type Messages, MessagesCard, ObjectLink, ObjectMenu, type Person } from "../../chat/Object.tsx";
import { Watching, type WatchRowView } from "../../chat/Panel.tsx";
import { scopesOfChoice } from "../../lib/connect.ts";
import { choicesOf } from "../fixtures.ts";
import { Section } from "../stage.tsx";

const TODAY = new Date();
const at = (hours: number, minutes: number) => {
	const when = new Date(TODAY);
	when.setHours(hours, minutes, 0, 0);
	return when.toISOString();
};

export const SLACK_THREAD: Messages = {
	title: "Release notes draft for Thursday",
	search: false,
	service: "slack",
	place: "thread",
	channel: "#general",
	total: 6,
	url: "https://acme.slack.com/archives/C0GENERAL/p1700000000000100",
	messages: [
		{
			id: "1700000500.000600",
			from: "@deploybot [bot]",
			subject: "",
			date: at(10, 42),
			text: "Deploy 41 finished and healthy",
		},
		{
			id: "1700000400.000500",
			from: "@olga (outside)",
			subject: "",
			date: at(10, 31),
			text: "From our side the partner API is ready whenever you are",
		},
		{
			id: "1700000300.000400",
			from: "@bob",
			subject: "",
			date: at(10, 12),
			text: "@ana can you check #deploys before we ship?",
		},
		{ id: "1700000200.000300", from: "@ana", subject: "", date: at(9, 58), text: "Looks good to me" },
		{ id: "1700000000.000100", from: "@bob", subject: "", date: at(9, 40), text: "Release notes draft for Thursday" },
	],
};

const CHANNEL: Messages = {
	title: "#deploys",
	search: false,
	service: "slack",
	place: "channel",
	topic: "Every deploy, green or red. Ping #oncall when red.",
	members: 14,
	total: null,
	url: "https://acme.slack.com/archives/G0DEPLOYS",
	messages: [
		{
			id: "1700000900.000900",
			from: "@deploybot [bot]",
			subject: "",
			date: at(11, 5),
			text: "deploy 42 failed: migrations timed out (https://ci.example.test/run/42)",
		},
		{
			id: "1700000800.000800",
			from: "@bob",
			subject: "",
			date: at(10, 50),
			text: "rolling back 42, looking at the migration",
		},
	],
};

const GENERAL: Messages = { ...CHANNEL, title: "#general", url: "https://acme.slack.com/archives/C0GENERAL" };

const DM: Messages = {
	title: "@bob",
	search: false,
	service: "slack",
	place: "channel",
	topic: "",
	members: null,
	total: null,
	messages: [],
};

const SEARCH: Messages = {
	title: "from:@bob failed",
	search: true,
	service: "slack",
	total: 23,
	messages: [
		{
			id: "1700000900.000900",
			from: "@bob",
			subject: "",
			date: at(11, 5),
			text: "deploy 42 failed: migrations timed out",
		},
		{
			id: "1690000000.000100",
			from: "@bob",
			subject: "",
			date: "2023-07-22T08:26:40.000Z",
			text: "tests failed on main again, retrying",
		},
	],
};

const BOB: Person = {
	name: "Bob Stone",
	emails: "bob@acme.example",
	phones: "",
	organization: "",
	title: "Engineer",
	other: false,
	service: "slack",
	handle: "@bob",
	status: "On call",
	timezone: "America/New_York",
	outside: false,
	url: "https://acme.slack.com/team/U0BOB",
};

const OLGA: Person = {
	name: "Olga Ivanova",
	emails: "",
	phones: "",
	organization: "",
	title: "Partner engineer",
	other: false,
	service: "slack",
	handle: "@olga",
	status: "",
	timezone: "Europe/Berlin",
	outside: true,
	url: "https://acme.slack.com/team/U0OLGA",
};

type Draft = Parameters<typeof DraftApproval>[0]["ask"];
const AS = "@ana at Acme on Slack";

const DRAFTS: readonly (readonly [string, Draft, string, Messages])[] = [
	[
		"Draft: reply in a thread",
		{
			type: "approval",
			tool: "slack__post_message",
			verb: "Send",
			as: AS,
			floor: "private",
			editable: ["text"],
			on: { refs: ["slack:thread:slack/C0GENERAL/p1700000000.000100"], account: "@ana at Acme" },
			args: {
				channel: "C0GENERAL",
				thread_ts: "1700000000.000100",
				text: "<!here> notes are final. <@U0BOB> I'll look at <#G0DEPLOYS> after lunch.",
				_channel_name: "general",
				_names: { U0BOB: "@bob", G0DEPLOYS: "#deploys" },
				account: "@ana at Acme",
			},
		},
		"Reply in thread in #general",
		SLACK_THREAD,
	],
	[
		"Draft: post in a channel",
		{
			type: "approval",
			tool: "slack__post_message",
			verb: "Send",
			as: AS,
			floor: "private",
			editable: ["text"],
			on: { refs: ["slack:channel:slack/G0DEPLOYS"], account: "@ana at Acme" },
			args: {
				channel: "G0DEPLOYS",
				text: "Rolled back 42; the migration needs an index first.",
				_channel_name: "deploys",
				_names: {},
				account: "@ana at Acme",
			},
		},
		"Post in #deploys",
		CHANNEL,
	],
];

/** Mara's Slack watches: a thread looking, a channel behind a burst, another paused. */
const SLACK_WATCHES: readonly WatchRowView[] = [
	{
		id: "release-notes",
		name: "a thread in Slack",
		service: "Slack",
		object: { ref: "thread" },
		next: "today 09:45",
		saw: "Saw today 09:40: @bob replied",
	},
	{
		id: "general",
		name: "a channel in Slack",
		service: "Slack",
		object: { ref: "channel" },
		next: "today 09:41",
		saw: "Behind since today 09:40: more came than a page holds, reading a page a look",
		behind: true,
	},
	{
		id: "deploys",
		name: "a channel in Slack",
		service: "Slack",
		object: { ref: "deploys" },
		saw: "Saw today 08:10: @deploybot [bot]: deploy 41 green",
		paused: true,
	},
];

const CARDS: readonly (readonly [string, Messages])[] = [
	["A thread, with a bot and someone from another team", SLACK_THREAD],
	["A channel, its topic and members", CHANNEL],
	["A direct message, nothing yet", DM],
	["A search", SEARCH],
	["A search, no matches", { ...SEARCH, title: "in:general launch party", total: 0, messages: [] }],
];

export function SlackSection() {
	const choices = choicesOf("slack");
	const [scopes, setScopes] = useState<readonly string[]>(
		choices?.required === undefined ? [] : scopesOfChoice(choices.required),
	);
	return (
		<Section
			id="slack"
			note="Your Slack as you see it: threads, channels, searches and people as cards. Every message banda sends as you asks you, every time."
		>
			<div className="grid gap-6 lg:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Slack's tile</span>
					<span className="flex items-center gap-2 rounded-field border border-line-soft bg-paper-2 p-3 text-body text-ink">
						<ConnectionIcon connection="slack" />
						Slack
						<span className="text-meta text-ink-2">· @ana at Acme</span>
					</span>
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Access to choose before signing in</span>
					<ConnectionPermissions choices={choices} service="Slack" scopes={scopes} onScopes={setScopes} />
				</div>
				{CARDS.map(([label, list]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<MessagesCard list={list} />
					</div>
				))}
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Following: Mara's Slack watches</span>
					<Watching
						agent="Mara"
						watches={SLACK_WATCHES}
						inline={(ref) => {
							const list = ref === "thread" ? SLACK_THREAD : ref === "channel" ? GENERAL : CHANNEL;
							return <ObjectLink object={{ ...list, card: "messages" }} href={list.url ?? ""} />;
						}}
					/>
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Follow on a channel: a mention wakes, the rest tells</span>
					<span className="flex items-center gap-2 text-body text-ink">
						#general
						<ObjectMenu
							name="#general"
							details={[["Read", "today 09:40"]]}
							follow={{
								ends: [],
								onFollow: () => {},
								says: "A message that mentions you wakes Mara; every other message only tells. To follow words, or mentions in threads, follow a Slack search: slack/search/in:#general your words.",
							}}
						/>
					</span>
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">A person</span>
					<ContactCard person={BOB} />
				</div>
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">A person from another team</span>
					<ContactCard person={OLGA} />
				</div>
				{DRAFTS.map(([label, ask, words, drawn]) => (
					<div key={label} className="flex min-w-0 flex-col gap-1.5">
						<span className="text-meta text-ink-2">{label}</span>
						<DraftApproval
							chat={0}
							agent={{ name: "Mara" }}
							label={words}
							ask={ask}
							wait={`specimen-${label}`}
							drawn={<MessagesCard list={drawn} />}
						/>
					</div>
				))}
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-meta text-ink-2">Named in a message</span>
					<Bubble mine>
						What did <ObjectLink object={{ ...BOB, card: "contact" }} href="https://acme.slack.com/team/U0BOB" /> say in{" "}
						<ObjectLink object={{ ...SLACK_THREAD, card: "messages" }} href={SLACK_THREAD.url ?? ""} />?
					</Bubble>
					<Bubble mine>
						Reply to{" "}
						<ObjectLink
							object={{ ...SLACK_THREAD, card: "messages" }}
							href="https://acme.slack.com/archives/C0GENERAL/p1700000300000400?thread_ts=1700000000.000100&cid=C0GENERAL"
						/>{" "}
						please
					</Bubble>
				</div>
			</div>
		</Section>
	);
}
