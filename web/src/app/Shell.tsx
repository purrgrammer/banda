/**
 * The app (DESIGN.md "The app"): the band at the left, a chat in the middle, its panel at the right (a sheet on the
 * phone, where the band is the first screen and a chat opens over it). Settings and Connections are plain pages.
 * `#/` opens the chat last shown on this device, else the first agent's. The tab's title counts asks, then unread.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DEFAULT_FACE } from "../../../src/core/choices.ts";
import type { CompanionView } from "../../../src/server/api.ts";
import { pinRow, usePinnedRows } from "../areas/band.ts";
import { archiveGroup, setGroupLimits } from "../areas/groups.ts";
import { actOnRoutine, clickKey } from "../areas/routines.ts";
import { useTiers } from "../areas/tiers.ts";
import { Band, BandNotice } from "../chat/Band.tsx";
import { Catalogue } from "../chat/Catalogue.tsx";
import { Face, FaceStack } from "../chat/Face.tsx";
import { MemorySettings } from "../chat/MemorySettings.tsx";
import { AgentPanel, firstTab, Panel, Routines } from "../chat/Panel.tsx";
import { AppSettings, Archive, Personality, SettingsPage, ThinkingTiers } from "../chat/Settings.tsx";
import { SkillCatalogue } from "../chat/Skill.tsx";
import { actOnFact, setPaused, signOutAccount, signOutSite } from "../lib/api.ts";
import { attempt } from "../lib/attempt.ts";
import { agentMainOf } from "../lib/chats.ts";
import { type ArchivedAgent, archivedAgents, chatAgents } from "../lib/navigation.ts";
import { setTheme, useTheme } from "../lib/prefs.ts";
import { showAgents, showCapabilities, showControl, showMemory, useShell } from "../lib/shell.ts";
import { AccessTab, reachesSomething } from "./Access.tsx";
import { AgentChat } from "./AgentChat.tsx";
import { ArtifactPage } from "./ArtifactPage.tsx";
import { BringOnboarding, BringSettings, useBring } from "./Bring.tsx";
import { bandRows, titleOf, whoOf } from "./band.ts";
import { ConnectFlow, freshAccounts } from "./ConnectFlow.tsx";
import { saveEdit, setAgentState } from "./edits.ts";
import { GroupChat } from "./GroupChat.tsx";
import { AddHarnessButton, HarnessConnectionTile } from "./HarnessConnections.tsx";
import { BrowserDialog } from "./LiveBrowser.tsx";
import { McpSetup } from "./McpSetup.tsx";
import { NewSheet } from "./NewSheet.tsx";
import { useAskNotifications, useNotify } from "./notify.ts";
import { Onboarding, SkillsOnboarding, useShippedSkills } from "./Onboarding.tsx";
import { ownerEdits } from "./owner-edits.ts";
import { EditRoutine, routineRows } from "./routines.tsx";
import { SearchDialog } from "./SearchDialog.tsx";
import { SettingsDevices } from "./SettingsDevices.tsx";
import { SettingsProviders } from "./SettingsProviders.tsx";
import { ShortcutsDialog, typing as typingIn } from "./Shortcuts.tsx";
import { SkillsPage, useSkills, waitsOnOwner } from "./Skills.tsx";
import { routineTitle } from "./titles.ts";
import { hrefOf, lastOf, parse, type Where } from "./where.ts";

const LAST = "banda.last";

function useWhere(): Where {
	const [hash, setHash] = useState(location.hash);
	useEffect(() => {
		const changed = () => setHash(location.hash);
		addEventListener("hashchange", changed);
		return () => removeEventListener("hashchange", changed);
	}, []);
	return parse(hash);
}

const go = (where: Where) => {
	location.hash = hrefOf(where);
};

const openRow = (row: { to: Where }) => go(row.to);

function usePhone(): boolean {
	const query = "(max-width: 767px)";
	const [phone, setPhone] = useState(() => matchMedia(query).matches);
	useEffect(() => {
		const list = matchMedia(query);
		const changed = () => setPhone(list.matches);
		list.addEventListener("change", changed);
		return () => list.removeEventListener("change", changed);
	}, []);
	return phone;
}

const SERVICES = [
	{ id: "gmail", name: "Gmail", does: "Read and draft email" },
	{ id: "linear", name: "Linear", does: "Issues and cycles" },
	{ id: "slack", name: "Slack", does: "Channels and messages" },
	{ id: "notion", name: "Notion", does: "Pages and databases" },
];

export function Shell() {
	const tiers = useTiers();
	const [shipped, setShipped] = useShippedSkills();
	const [brought, setBrought] = useBring();
	// first run until the band can think: a provider with a credential, and not one from outside banda that the owner
	// never picked (a stale ANTHROPIC_API_KEY would otherwise skip this screen and fail every answer)
	const current = tiers?.providers.find((provider) => provider.id === tiers.provider.id);
	if (tiers !== undefined && (current === undefined || (current.ambient === true && !tiers.chosen)))
		return (
			<div className="h-svh bg-paper">
				<Onboarding />
			</div>
		);
	// right after the provider, once: in the desktop app, what the other harnesses on this computer have; when the owner
	// brings nothing from them (or there are none), the skills banda ships
	if (brought === undefined || shipped === undefined) return <div className="h-svh bg-paper" />;
	if (!brought.view.chosen)
		return (
			<div className="h-svh bg-paper">
				<BringOnboarding
					view={brought.view}
					harnesses={brought.harnesses}
					onChosen={(next, brought) => {
						if (brought) setShipped({ ...shipped, chosen: true });
						setBrought({ view: next });
					}}
				/>
			</div>
		);
	if (!shipped.chosen)
		return (
			<div className="h-svh bg-paper">
				<SkillsOnboarding view={shipped} onChosen={setShipped} />
			</div>
		);
	return <Main />;
}

function Main() {
	const shell = useShell();
	const { list: skillViews } = useSkills();
	const skillSummaries = skillViews.flatMap(({ accepted }) =>
		accepted === undefined ? [] : [{ name: accepted.name, description: accepted.description }],
	);
	const tiers = useTiers();
	const theme = useTheme();
	// Debounce typing, but submit identity picks at once. Each agent's saves use the newest accepted file.
	const latest = useRef(shell);
	latest.current = shell;
	const [edit] = useState(() =>
		ownerEdits((agent, change) =>
			attempt("save the agent's changes", async () => {
				await saveEdit(agent, change, latest.current.agents, latest.current.companion, (updated) => {
					latest.current = { ...latest.current, agents: updated };
					showAgents(updated);
				});
			}),
		),
	);
	/** The agents whose panel opened on Access this session: connecting there does not move it to About. */
	const onAccess = useRef(new Set<string>());
	/** Back from a page: to the chat shown last on this device, else home. */
	const back = () => {
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(LAST);
		} catch {}
		go(lastOf(stored) ?? { name: "home" });
	};
	const where = useWhere();
	const phone = usePhone();
	const pinned = usePinnedRows();
	// closed by default, so the screen is the conversation; it opens for what needs room (a routine, the face tapped)
	const [panel, setPanel] = useState(false);
	const [sheet, setSheet] = useState(false);
	const [searching, setSearching] = useState(false);
	const [shortcuts, setShortcuts] = useState(false);
	const [making, setMaking] = useState(false);
	// the routine open in the panel's editor (none: a new one), and a routine's line asking for the agent's routines
	const [editing, setEditing] = useState<{ agent: string; routine?: string }>();
	const [focus, setFocus] = useState<{ agent: string; n: number }>();
	// when the daemon last pushed the routines: their next runs are read then, so they never tick on their own
	// biome-ignore lint/correctness/useExhaustiveDependencies: a push is what moves it
	const pushedAt = useMemo(() => Date.now(), [shell.control]);
	const companion: CompanionView = shell.companion ?? { face: DEFAULT_FACE };
	const agents = useMemo(() => chatAgents(shell.agents, companion), [shell.agents, companion]);
	// archived agents leave the band, but a group's history and Settings still name them
	const archived = useMemo(() => archivedAgents(shell.agents, companion), [shell.agents, companion]);
	const restore = (id: string) => setAgentState(id, "active", shell.agents).then(showAgents);
	// what agents changed that waits for the owner: a routine one wrote, its own file
	const waiting = useMemo(() => {
		const words = (name: string, description?: string) => routineTitle(name, description);
		return [
			...(shell.control?.routines ?? []).flatMap((routine) =>
				routine.change === undefined
					? []
					: [
							{
								agent: routine.agent,
								words:
									routine.change.kind === "removed"
										? `stop ${words(routine.name, routine.accepted?.routine?.description)}?`
										: routine.change.kind === "changed"
											? `change ${words(routine.name, routine.change.routine?.description)}?`
											: `set up ${words(routine.name, routine.change.routine?.description)}?`,
							},
						],
			),
			...shell.agents.flatMap((agent) =>
				agent.change === undefined || agent.change.kind === "removed" || agent.accepted?.agent === undefined
					? []
					: [{ agent: agent.accepted.agent.id, words: "a change to its own file?" }],
			),
		];
	}, [shell.control?.routines, shell.agents]);
	const rows = useMemo(
		() =>
			bandRows(
				agents,
				shell.rows,
				shell.groups ?? [],
				shell.control?.paused !== undefined,
				Date.now(),
				waiting,
				archived,
				shell.harnesses?.sessions,
			),
		[agents, shell.rows, shell.groups, shell.control?.paused, waiting, archived, shell.harnesses?.sessions],
	);

	// `#/` opens the last chat shown here, else the first agent's
	useEffect(() => {
		if (where.name !== "home") {
			if (where.name === "agent" || where.name === "group") {
				try {
					localStorage.setItem(
						LAST,
						hrefOf(where.name === "agent" ? { name: "agent", id: where.id } : { name: "group", room: where.room }),
					);
				} catch {}
			}
			return;
		}
		if (phone || !shell.loaded) return;
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(LAST);
		} catch {}
		// only a chat this home has: the last one may be another home's, or gone since
		const last = lastOf(stored);
		const known =
			last?.name === "agent"
				? agents.some((each) => each.id === last.id)
				: last?.name === "group" &&
					(shell.groups ?? []).some((group) => group.room === last.room && group.archived === undefined);
		const first = agents[0];
		if (last !== undefined && known) location.replace(hrefOf(last));
		else if (first !== undefined) location.replace(hrefOf({ name: "agent", id: first.id }));
	}, [where, phone, agents, shell.loaded, shell.groups]);

	useEffect(() => {
		document.title = titleOf(rows);
	}, [rows]);
	const [notify, setNotify] = useNotify();
	useAskNotifications(rows, notify === "on", openRow);

	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setSearching(true);
			}
			if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
				const row = rows[Number(event.key) - 1];
				if (row !== undefined) {
					event.preventDefault();
					go(row.to);
				}
			}
			// Alt+↑ and Alt+↓: the chat above or below the open one in the band
			if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
				const open = where.name === "agent" ? `a:${where.id}` : where.name === "group" ? `g:${where.room}` : undefined;
				const at = rows.findIndex((row) => row.id === open);
				const next = rows[at < 0 ? 0 : at + (event.key === "ArrowUp" ? -1 : 1)];
				if (next !== undefined) {
					event.preventDefault();
					go(next.to);
				}
			}
			// "?": the shortcuts, unless it is typed into something
			if (event.key === "?" && !event.metaKey && !event.ctrlKey && !typingIn(event.target)) {
				event.preventDefault();
				setShortcuts(true);
			}
			// Esc closes the panel, unless a dialog, a menu or a field took it first
			const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable]");
			if (
				event.key === "Escape" &&
				!phone &&
				!event.defaultPrevented &&
				typing === null &&
				document.querySelector('[role="dialog"], [role="menu"]') === null
			)
				setPanel(false);
		};
		addEventListener("keydown", key);
		return () => removeEventListener("keydown", key);
	}, [rows, phone, where]);

	const selected = where.name === "agent" ? `a:${where.id}` : where.name === "group" ? `g:${where.room}` : undefined;
	const showBand = !phone || where.name === "home";
	const band = (
		<Band
			rows={rows}
			pinned={pinned}
			onPin={pinRow}
			phone={phone}
			selected={selected}
			loading={!shell.loaded}
			{...(phone ? { className: "w-full" } : {})}
			{...(shell.offline ? { notice: <BandNotice>Can't reach banda on this computer. Trying again…</BandNotice> } : {})}
			onSelect={(id) => {
				const row = rows.find((each) => each.id === id);
				if (row !== undefined) go(row.to);
			}}
			onSearch={() => setSearching(true)}
			onNew={() => setMaking(true)}
			onSkills={() => go({ name: "skills" })}
			waiting={{
				skills: skillViews.some(waitsOnOwner),
				// a problem, or an account to sign in to again; a change to a connection's file is answered in the chat
				connections: (shell.capabilities?.connections ?? []).some(
					(view) => view.state === "problem" || (view.accounts ?? []).some((account) => account.stale === true),
				),
			}}
			onConnections={() => go({ name: "connections" })}
			onSettings={() => go({ name: "settings" })}
		/>
	);

	const main = (() => {
		if (where.name === "agent" && shell.loaded && !agents.some((each) => each.id === where.id)) {
			const gone = archived.find((each) => each.id === where.id);
			return gone === undefined ? (
				<Gone what="This agent" onHome={() => go({ name: "home" })} />
			) : (
				<Archived who={gone} onRestore={() => restore(gone.id)} onHome={() => go({ name: "home" })} />
			);
		}
		if (where.name === "group" && shell.groups !== undefined && !shell.groups.some((g) => g.room === where.room))
			return <Gone what="This group" onHome={() => go({ name: "home" })} />;
		const archivedGroup =
			where.name === "group" ? shell.groups?.find((g) => g.room === where.room && g.archived !== undefined) : undefined;
		if (archivedGroup !== undefined)
			return (
				<ArchivedGroupPage
					name={archivedGroup.name}
					faces={archivedGroup.members.map((id) => whoOf([...agents, ...archived], id))}
					onRestore={() => archiveGroup(archivedGroup.room, false)}
					onHome={() => go({ name: "home" })}
				/>
			);
		if (where.name === "agent") {
			const agent = agents.find((each) => each.id === where.id);
			const who = whoOf(agents, where.id);
			const row = agentMainOf(shell.rows, where.id);
			const chat = (
				<AgentChat
					key={where.id}
					agent={where.id}
					at={where.at}
					who={who}
					row={row}
					phone={phone}
					panelOpen={panel}
					onBack={() => go({ name: "home" })}
					onPanel={() => (phone ? setSheet(true) : setPanel((open) => !open))}
					onRoutine={() => {
						setEditing(undefined);
						setFocus((was) => ({ agent: where.id, n: (was?.agent === where.id ? was.n : 0) + 1 }));
						if (phone) setSheet(true);
						else setPanel(true);
					}}
				/>
			);
			if (agent === undefined) return chat;
			// an agent's routines wake in its chat; their times are read when the daemon last pushed them
			const routines = routineRows(shell.control?.routines ?? [], where.id, pushedAt);
			const editor =
				editing?.agent === where.id ? (
					<EditRoutine
						agent={where.id}
						name={who.name}
						routine={shell.control?.routines.find((each) => each.name === editing.routine)}
						now={pushedAt}
						onDone={() => setEditing(undefined)}
					/>
				) : undefined;
			const agentFile = shell.agents.find((each) => each.accepted?.agent?.id === where.id)?.accepted;
			const personality = where.id === "sancho" ? companion.personality : agentFile?.agent?.instructions;
			const agentPanel = (
				<Panel name={who.name} phone={phone} onClose={() => setSheet(false)}>
					{editor ?? (
						<AgentPanel
							// a routine's line asks for its routines: the panel opens again on them
							key={`${where.id}:${focus?.agent === where.id ? focus.n : 0}`}
							who={who}
							state={row?.state === "running" ? "working" : row?.state === "waiting" ? "waiting" : "idle"}
							// Access while it can reach nothing (until the daemon says what it can, as if it could); once
							// opened on Access, connecting there keeps it there, so the card the owner is on stays
							tab={(() => {
								if (focus?.agent === where.id) return "routines";
								const suggested = firstTab({
									routines: routines.length,
									connected: shell.capabilities === undefined || reachesSomething(shell.capabilities, where.id),
								});
								if (suggested === "access") onAccess.current.add(where.id);
								return suggested === "about" && onAccess.current.has(where.id) ? "access" : suggested;
							})()}
							routines={
								<Routines
									agent={who.name}
									routines={routines}
									allPaused={shell.control?.paused !== undefined}
									onAllPaused={(paused) => void setPaused(paused).then(showControl)}
									onAdd={() => setEditing({ agent: where.id })}
									onOpen={(id) => setEditing({ agent: where.id, routine: id })}
									onRunNow={(id) => void actOnRoutine(id, { action: "run", key: clickKey() }).then(showControl)}
									onPause={(id, paused) =>
										void actOnRoutine(id, { action: paused ? "pause" : "resume" }).then(showControl)
									}
								/>
							}
							access={
								<AccessTab
									agent={{ id: where.id, name: who.name }}
									capabilities={shell.capabilities}
									control={shell.control}
								/>
							}
							memory={
								<MemorySettings
									agent={{ id: where.id, name: who.name }}
									memory={shell.memory}
									onAdd={async (text, scope) => {
										showMemory(
											await actOnFact({
												action: "add",
												text,
												scope,
												...(scope === "agent" ? { agent: where.id } : {}),
											}),
										);
									}}
									onEdit={async (id, text) => {
										showMemory(await actOnFact({ action: "edit", id, text }));
									}}
									onForget={async (id) => {
										showMemory(await actOnFact({ action: "delete", id }));
									}}
								/>
							}
							onIdentity={(next) =>
								edit(
									where.id,
									{
										...(JSON.stringify(next.face) === JSON.stringify(who.face) ? {} : { face: next.face }),
										...(next.name === who.name ? {} : { name: next.name }),
									},
									true,
								)
							}
							about={
								<>
									<Personality
										key={`${where.id}-personality-${personality === undefined ? "none" : "read"}`}
										text={personality}
										onChange={(text) => edit(where.id, { personality: text })}
									/>
									<ThinkingTiers />
									<SkillCatalogue skills={skillSummaries} hrefFor={(name) => `#/skills/${name}`} />
									<a href="#/skills" className="text-ui text-ink-2 underline underline-offset-4">
										Manage shared skills
									</a>
									<Archive
										key={`${where.id}-archive`}
										agent={who.name}
										last={agents.length <= 1}
										onArchive={() =>
											setAgentState(where.id, "archived", shell.agents).then((views) => {
												showAgents(views);
												setSheet(false);
												go({ name: "home" });
											})
										}
									/>
								</>
							}
						/>
					)}
				</Panel>
			);
			if (phone) return sheet ? agentPanel : chat;
			return (
				<>
					{chat}
					{panel ? agentPanel : null}
				</>
			);
		}
		if (where.name === "group")
			return (
				<GroupChat
					key={where.room}
					room={where.room}
					at={where.at}
					agents={agents}
					archived={archived}
					phone={phone}
					onBack={() => go({ name: "home" })}
					onArchived={() => {
						// it left the band: to a chat that is in it (the band itself on the phone), never through the
						// home's redirect, which may still remember this group until the shell says it is archived
						const first = agents[0];
						go(phone || first === undefined ? { name: "home" } : { name: "agent", id: first.id });
					}}
				/>
			);
		if (where.name === "artifact")
			return (
				<ArtifactPage
					key={where.id}
					id={where.id}
					v={where.v}
					nameOf={(chat) => whoOf(agents, shell.rows.find((each) => each.chat === chat)?.agent ?? "sancho").name}
					onBack={(chat) => {
						const agent = shell.rows.find((each) => each.chat === chat)?.agent;
						if (agent === undefined) back();
						else go({ name: "agent", id: agent });
					}}
					onVersion={(v) =>
						location.replace(hrefOf({ name: "artifact", id: where.id, ...(v === undefined ? {} : { v }) }))
					}
				/>
			);
		if (where.name === "skills" || where.name === "skill")
			return (
				<SkillsPage
					{...(where.name === "skill" ? { name: where.id } : {})}
					phone={phone}
					onBack={() => (where.name === "skill" ? go({ name: "skills" }) : back())}
					onOpen={(id) => go({ name: "skill", id })}
				/>
			);
		if (where.name === "settings")
			return (
				<SettingsPage title="Settings" phone={phone} onBack={back}>
					<AppSettings
						bring={<BringSettings />}
						memory={
							<MemorySettings
								memory={shell.memory}
								onAdd={async (text) => {
									showMemory(await actOnFact({ action: "add", text, scope: "global" }));
								}}
								onEdit={async (id, text) => {
									showMemory(await actOnFact({ action: "edit", id, text }));
								}}
								onForget={async (id) => {
									showMemory(await actOnFact({ action: "delete", id }));
								}}
							/>
						}
						data={{
							provider: tiers?.provider ?? { id: "", name: "No provider" },
							models: {
								quick: tiers?.models.quick.name ?? "",
								balanced: tiers?.models.balanced.name ?? "",
								deep: tiers?.models.deep.name ?? "",
							},
							accounts: (shell.capabilities?.connections ?? []).flatMap((view) =>
								(view.accounts ?? []).map((account) => ({
									id: `${view.name}/${account.account}`,
									name: view.name,
									connection: view.accepted?.connection?.service ?? view.name,
									login: account.label,
									agents: account.agents.map((agent) => whoOf(agents, agent).name),
									...(account.stale === true ? { stale: true } : {}),
								})),
							),
							archivedGroups: (shell.groups ?? []).flatMap((group) =>
								group.archived === undefined
									? []
									: [
											{
												room: group.room,
												name: group.name,
												faces: group.members.map((id) => whoOf([...agents, ...archived], id)),
												when: new Date(group.archived).toLocaleDateString([], { day: "numeric", month: "short" }),
											},
										],
							),
							...(shell.groupLimits === undefined ? {} : { groupLimits: shell.groupLimits }),
							archived: archived.map((each) => ({
								id: each.id,
								face: each.face,
								name: each.name,
								when:
									each.at === undefined
										? "earlier"
										: new Date(each.at).toLocaleDateString([], { day: "numeric", month: "short" }),
							})),
							theme,
							paused: shell.control?.paused !== undefined,
							...(shell.computer === undefined ? {} : { computer: shell.computer }),
							signedIn: (shell.capabilities?.signedIn ?? []).map(({ agent, site, at }) => ({
								agent: { ...whoOf(agents, agent), id: agent },
								site,
								when: new Date(at).toLocaleDateString([], { day: "numeric", month: "short" }),
							})),
							notify,
						}}
						onNotify={setNotify}
						providers={<SettingsProviders current={tiers?.provider.id ?? ""} />}
						devices={<SettingsDevices />}
						onTheme={setTheme}
						onPause={(paused) => void setPaused(paused)}
						onConnect={() => go({ name: "connections" })}
						onSignOut={(agent, site) => void signOutSite(agent, site).then(showCapabilities)}
						onAccountSignOut={(account) => {
							const [name = "", key = ""] = account.id.split("/");
							void signOutAccount(name, key)
								.then(showCapabilities)
								.catch(() => {});
						}}
						connect={(name, close) => <ConnectFlow connection={name} onDismiss={close} />}
						onRestore={(who) => (who.id === undefined ? undefined : restore(who.id))}
						onRestoreGroup={(room) => archiveGroup(room, false)}
						onGroupLimits={(limits) => setGroupLimits(limits)}
					/>
				</SettingsPage>
			);
		if (where.name === "connections") {
			if (where.add || where.connection)
				return (
					<SettingsPage title="Connections" phone={phone} onBack={() => go({ name: "connections" })}>
						<McpSetup
							{...(where.connection ? { connection: where.connection } : {})}
							onCreated={(connection) => go({ name: "connections", connection })}
							onClose={() => go({ name: "connections" })}
						/>
					</SettingsPage>
				);
			const capabilities = shell.capabilities;
			// what banda can connect: those it ships and those added, each with its accounts; then what is coming
			const names = [
				...new Set([
					...(capabilities?.shipped ?? []).map((each) => each.name),
					...(capabilities?.connections ?? [])
						.filter((each) => each.accounts !== undefined || each.agents !== undefined)
						.map((each) => each.name),
				]),
			];
			const services = names.map((name) => {
				const view = capabilities?.connections.find((each) => each.name === name);
				const shipped = capabilities?.shipped?.find((each) => each.name === name);
				return {
					id: name,
					name: view?.accepted?.connection?.service ?? shipped?.connection.service ?? name,
					does: name === "github" ? "Pull requests, issues, checks" : (view?.accepted?.connection?.where ?? ""),
					accounts: freshAccounts(view).map((account) => account.label),
					managed: view?.agents !== undefined,
					stale: (view?.accounts ?? []).filter((account) => account.stale === true).map((account) => account.label),
					problem: view?.state === "problem" ? (view.problem ?? "Not reached") : undefined,
				};
			});
			return (
				<SettingsPage title="Connections" phone={phone} onBack={back}>
					<span className="flex flex-wrap gap-2">
						<Button className="self-start" onClick={() => go({ name: "connections", add: true })}>
							Add MCP server
						</Button>
						<AddHarnessButton />
					</span>
					<Catalogue
						extra={(shell.harnesses?.harnesses ?? [])
							.filter(({ name }) => shell.harnesses?.accounts[name] !== undefined)
							.map(({ name }) => ({ key: `harness:${name}`, card: <HarnessConnectionTile name={name} /> }))}
						onManage={(connection) => go({ name: "connections", connection })}
						services={[
							...(services.length === 0
								? [{ id: "github", name: "GitHub", does: "Pull requests, issues, checks", accounts: [] }]
								: services),
							...SERVICES.filter((service) => !services.some((existing) => existing.id === service.id)),
						]}
						connect={(service, close) =>
							service.accounts === undefined ? null : capabilities?.connections.find((each) => each.name === service.id)
									?.agents !== undefined ? (
								<Button
									variant="outline"
									className="self-start"
									onClick={() => go({ name: "connections", connection: service.id })}
								>
									Manage connection
								</Button>
							) : (
								<ConnectFlow connection={service.id} onDismiss={close} />
							)
						}
					/>
				</SettingsPage>
			);
		}
		return null;
	})();

	return (
		<div className="flex h-svh bg-paper text-ink">
			{showBand ? band : null}
			{phone && where.name === "home" ? null : <main className="flex min-w-0 flex-1">{main}</main>}
			{making ? <NewSheet open={making} onOpenChange={setMaking} agents={agents} onGo={go} /> : null}
			<BrowserDialog who={(chat) => whoOf(agents, shell.rows.find((each) => each.chat === chat)?.agent ?? "sancho")} />
			<SearchDialog
				open={searching}
				onOpenChange={setSearching}
				whoOf={(agent) => whoOf(agents, agent)}
				groupName={(room) => shell.groups?.find((group) => group.room === room)?.name ?? "a group"}
				onGo={go}
			/>
			<ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
		</div>
	);
}

/** A chat this home does not have: another home's link, or one removed since. */
function Gone({ what, onHome }: { what: string; onHome: () => void }) {
	return (
		<div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6 text-center">
			<p className="text-ui text-ink-2">{what} isn't in your band.</p>
			<Button variant="outline" size="sm" onClick={onHome}>
				Back to your band
			</Button>
		</div>
	);
}

/** An archived group's link: it is not in the band, its messages are kept, and Restore brings it back. */
function ArchivedGroupPage({
	name,
	faces,
	onRestore,
	onHome,
}: {
	name: string;
	faces: readonly ArchivedAgent[];
	onRestore: () => Promise<unknown>;
	onHome: () => void;
}) {
	const [error, setError] = useState<string | undefined>(undefined);
	return (
		<div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6 text-center">
			<FaceStack faces={faces.map((face) => ({ ...face, paused: true }))} name={name} size="panel" />
			<p className="max-w-[24rem] text-ui text-ink-2">
				{name} is archived. Its messages are kept; restored, it goes on where it was.
			</p>
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
			<div className="flex gap-2">
				<Button variant="outline" size="sm" onClick={onHome}>
					Back to your band
				</Button>
				<Button
					size="sm"
					onClick={() =>
						void onRestore().catch((failed: unknown) =>
							setError(failed instanceof Error ? failed.message : String(failed)),
						)
					}
				>
					Restore {name}
				</Button>
			</div>
		</div>
	);
}

/** An archived agent's link: it is not in the band, its chat is kept, and Restore brings it back. */
function Archived({
	who,
	onRestore,
	onHome,
}: {
	who: ArchivedAgent;
	onRestore: () => Promise<unknown>;
	onHome: () => void;
}) {
	const [error, setError] = useState<string | undefined>(undefined);
	return (
		<div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6 text-center">
			<Face face={who.face} name={who.name} size="panel" paused />
			<p className="max-w-[24rem] text-ui text-ink-2">
				{who.name} is archived. Its chat, memory and files are kept; restored, its routines stay paused until you resume
				them.
			</p>
			{error === undefined ? null : <p className="text-meta text-danger">{error}</p>}
			<div className="flex gap-2">
				<Button variant="outline" size="sm" onClick={onHome}>
					Back to your band
				</Button>
				<Button
					size="sm"
					onClick={() =>
						void onRestore().catch((failed: unknown) =>
							setError(failed instanceof Error ? failed.message : String(failed)),
						)
					}
				>
					Restore {who.name}
				</Button>
			</div>
		</div>
	);
}
