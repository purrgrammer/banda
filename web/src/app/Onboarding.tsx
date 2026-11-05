/**
 * First run (DESIGN.md "The app"): while no provider the band thinks with is connected, the first agent's screen with
 * the providers to pick from. A provider with a sign-in opens it in a tab of its own (opened from the tap, so it is
 * not blocked) and this screen waits for it; one without takes a key. Then the band opens.
 */
import { useProviderConnect } from "../areas/tiers.ts";
import { FirstRun } from "../chat/FirstRun.tsx";

/** Providers whose own sign-in comes first; the rest follow in the daemon's order. */
const FIRST = ["anthropic", "openai", "github-copilot", "google"];

export function Onboarding() {
	const { providers, open, waiting, error, pick, key } = useProviderConnect();
	const sorted = [...providers].sort((a, b) => (FIRST.indexOf(a.id) + 1 || 99) - (FIRST.indexOf(b.id) + 1 || 99));
	return (
		<FirstRun
			providers={sorted.map((provider) => ({
				id: provider.id,
				name: provider.name,
				by: provider.oauth ? ("sign-in" as const) : ("key" as const),
				...(provider.connected ? { note: "Connected · use it" } : {}),
			}))}
			open={open}
			waiting={waiting}
			error={error}
			onPick={(id) => void pick(id)}
			onKey={(id, value) => void key(id, value)}
		/>
	);
}
