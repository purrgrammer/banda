/** Words: how the app speaks when no one said it. Short, plain, second person; an error names who, what and the fix. */
import { CalendarClockIcon, CircleAlertIcon, CloudOffIcon, MonitorIcon, MonitorOffIcon, PauseIcon } from "lucide-react";
import { Line } from "../../chat/Line.tsx";
import { Group, Section } from "../stage.tsx";

const RULES = [
	"Short, plain, second person. No exclamation marks.",
	"An error names who, what and the fix, never the daemon's words.",
	"A tap says in words what it will do: Comment, Send, Sign in again.",
	"Nothing counts, streaks or nags.",
];

export function Copy() {
	return (
		<Section id="words" note="Lines in the chat that no one said: events, states and failures.">
			<Group label="Rules">
				<ul className="flex list-disc flex-col gap-1 pl-5 text-ui text-ink marker:text-ink-3">
					{RULES.map((rule) => (
						<li key={rule}>{rule}</li>
					))}
				</ul>
			</Group>
			<div className="flex flex-col gap-4 rounded-tile bg-paper-2 py-5">
				<Line icon={CalendarClockIcon} time="8:00">
					Morning brief ran
				</Line>
				<Line icon={MonitorIcon}>Mara's computer is starting…</Line>
				<Line icon={CircleAlertIcon} tone="danger" action={{ label: "Sign in again" }}>
					Mara can't answer: your Anthropic sign-in expired
				</Line>
				<Line icon={MonitorOffIcon} tone="danger" action={{ label: "Start it" }}>
					Mara's computer is off
				</Line>
				<Line icon={CircleAlertIcon} tone="danger" action={{ label: "Try again" }}>
					Mara didn't answer
				</Line>
				<Line icon={PauseIcon} action={{ label: "Resume" }}>
					Routines paused
				</Line>
				<Line icon={CloudOffIcon}>Can't reach banda on this computer. Trying again…</Line>
			</div>
		</Section>
	);
}
