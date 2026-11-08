/** Empty and loading: every place that waits on the daemon, and every place that can have nothing in it yet. */
import { useContext } from "react";
import { firstStarters, firstWords } from "../../app/first-words.ts";
import { Band } from "../../chat/Band.tsx";
import { Bubble, Run } from "../../chat/Feed.tsx";
import { Starters } from "../../chat/FirstRun.tsx";
import {
	ChatLoading,
	FileLoading,
	GroupEmpty,
	ObjectLoading,
	ObjectUnavailable,
	PanelLoading,
} from "../../chat/Loading.tsx";
import { Panel } from "../../chat/Panel.tsx";
import { Search } from "../../chat/Search.tsx";
import { AppSettings, SettingsPage } from "../../chat/Settings.tsx";
import { MARA, OTTO, ROWS, SANCHO, SETTINGS } from "../fixtures.ts";
import { ChatScreen } from "../screens/screens.tsx";
import { Group, Section, StageContext } from "../stage.tsx";

export function States() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	return (
		<>
			<Section
				id="loading-app"
				note="Before the daemon answers: the shapes of the band, the chat and the panel, so nothing jumps when they land."
				bleed
				wide
			>
				{phone ? null : <Band rows={[]} loading />}
				<ChatScreen name="Mara" faces={[MARA]}>
					<ChatLoading />
				</ChatScreen>
				{phone ? null : (
					<Panel name="Mara">
						<PanelLoading />
					</Panel>
				)}
			</Section>
			<Section id="empty-chat" note="Nothing said yet: the agent, and what to say first." bleed>
				{phone ? null : (
					<Band
						rows={[{ id: "otto", name: "Otto", faces: [OTTO], excerpt: "New", time: "now" }, ...ROWS]}
						selected="otto"
					/>
				)}
				<ChatScreen name="Otto" faces={[OTTO]}>
					<Run who={OTTO}>
						<Bubble>{firstWords("Otto")}</Bubble>
					</Run>
					<Starters starters={firstStarters()} />
				</ChatScreen>
			</Section>
			<Section id="states">
				<Group label="Search: searching · nothing found · failed, with Try again" className="items-start">
					<Search autoFocus={false} query="lisbon" searching />
					<Search autoFocus={false} query="kyoto" />
					<Search autoFocus={false} query="porto" onRetry={() => {}} />
				</Group>
				<Group label="A new group: nothing said yet">
					<GroupEmpty name="Sancho & Mara" faces={[SANCHO, MARA]} />
				</Group>
				<Group label="A new group: nobody in it yet">
					<GroupEmpty name="New group" faces={[]} />
				</Group>
				<Group label="An object: being read · can't be read" className="items-start">
					<div className="w-[24rem] max-w-full">
						<ObjectLoading />
					</div>
					<div className="w-[24rem] max-w-full">
						<ObjectUnavailable
							what="purrgrammer/banda #34"
							why="Octo can't read it: @bandarra signed out of GitHub."
							fix="Sign in again"
						/>
					</div>
				</Group>
				<Group label="A file while its preview is drawn" className="items-start">
					<FileLoading name="Booking terms.pdf" size="1.2 MB" />
				</Group>
				<Group label="Settings with no accounts, nothing archived" className="items-start">
					<div className="h-[520px] w-[30rem] max-w-full overflow-hidden rounded-tile border border-line-soft">
						<SettingsPage title="Settings">
							<AppSettings
								data={{
									...SETTINGS,
									accounts: [],
									computer: {
										state: "offline",
										why: "Docker isn't running: start Docker Desktop (or the Docker service), and the computer starts by itself.",
										box: "container",
										network: "guarded",
									},
									signedIn: [],
								}}
							/>
						</SettingsPage>
					</div>
				</Group>
				<Group label="Settings while the computer is built (the first run)" className="items-start">
					<div className="h-[520px] w-[30rem] max-w-full overflow-hidden rounded-tile border border-line-soft">
						<SettingsPage title="Settings">
							<AppSettings
								data={{ ...SETTINGS, computer: { state: "building", box: "container", network: "guarded" } }}
							/>
						</SettingsPage>
					</div>
				</Group>
			</Section>
		</>
	);
}
