/**
 * First run (DESIGN.md "The app"): while no provider the band thinks with is connected, the first agent's screen with
 * the providers to pick from. A provider with a sign-in opens it in a tab of its own (opened from the tap, so it is
 * not blocked) and this screen waits for it, takes the code its page shows when the page never comes back, or cancels
 * it; picked again, it starts over. One without a sign-in takes a key. A provider set from outside banda (an
 * ANTHROPIC_API_KEY around the daemon) is named by its source, and a tap uses it as the owner's pick; it never counts
 * as picked before. Then the band opens.
 */
import { useState } from "react";
import { SERVER_KINDS, type ServerKind } from "../../../src/core/custom-providers.ts";
import { useProviderConnect, wayLabel } from "../areas/tiers.ts";
import { AddProvider, type Step, setupWords } from "../chat/AddProvider.tsx";
import { FirstRun } from "../chat/FirstRun.tsx";
import { ProviderMark, ServerMark } from "../chat/ProviderMark.tsx";
import { runsOnDevice } from "../lib/api.ts";
import { useAddProviderActions } from "./SettingsProviders.tsx";

/** Providers whose own sign-in comes first; the rest follow in the daemon's order. */
const FIRST = ["anthropic", "openai", "github-copilot", "google"];

export function Onboarding() {
	const { providers, open, waiting, error, pick, answer, cancel, key, use } = useProviderConnect();
	const actions = useAddProviderActions();
	/** Add a provider, open at a step: all of them, one provider, or a kind of server. */
	const [more, setMore] = useState<Step | undefined>(undefined);
	// the providers banda has tiers picked for, and any already connected, one tap each; every other one, and a server
	// of the owner's, through More providers
	const offered = providers.filter(
		(provider) => provider.presets || provider.accounts.some((account) => account.connected),
	);
	const sorted = [...offered].sort((a, b) => (FIRST.indexOf(a.id) + 1 || 99) - (FIRST.indexOf(b.id) + 1 || 99));
	// first run connects a provider's first account alone; more come later, in Settings
	const first = sorted.flatMap((provider) => {
		const account = provider.accounts.find((each) => each.id === provider.id);
		return account === undefined ? [] : [{ provider, account }];
	});
	// what a search finds past those: every other provider, and each kind of server
	const others = [
		...providers
			.filter((provider) => !offered.includes(provider))
			.map((provider) => ({
				id: `provider:${provider.id}`,
				name: provider.name,
				note: setupWords(provider),
				mark: <ProviderMark provider={provider.id} className="size-6" />,
			})),
		...(Object.keys(SERVER_KINDS) as ServerKind[]).map((kind) => ({
			id: `server:${kind}`,
			name: SERVER_KINDS[kind].label,
			note: SERVER_KINDS[kind].about,
			keywords: ["local", "self-hosted", "server", kind],
			mark: <ServerMark kind={kind} className="size-6" />,
		})),
	];
	const byForm = new Set(providers.filter((provider) => provider.form !== undefined).map((provider) => provider.id));
	return (
		<FirstRun
			providers={first.map(({ provider, account }) => ({
				id: provider.id,
				name: provider.name,
				by: provider.oauth ? ("sign-in" as const) : ("key" as const),
				...(account.connected
					? {
							note:
								account.ambient === true
									? `From ${account.source ?? "your environment"}, outside banda · use it`
									: "Connected · use it",
						}
					: {}),
				connecting: account.connecting,
				asks: account.question !== undefined,
				ways: account.methods?.map((way) => ({ id: way.id, label: wayLabel(way) })),
				way: account.method,
			}))}
			open={open}
			waiting={waiting}
			error={error}
			onPick={(id) => {
				// an ambient key is usable as it is: the tap is the owner's pick of it (Settings connects over it)
				if (first.find((each) => each.account.id === id)?.account.ambient === true) void use(id);
				// a cloud's own form (Azure, Vertex, Bedrock) asks more than a key: it opens in Add a provider
				else if (byForm.has(id)) setMore({ kind: "builtin", id });
				else void pick(id);
			}}
			others={others}
			onOther={(id) => {
				const [what, value = ""] = id.split(":");
				setMore(what === "server" ? { kind: "server", server: value as ServerKind } : { kind: "builtin", id: value });
			}}
			onKey={(id, value) => void key(id, value)}
			onAnswer={(id, value) => void answer(id, value)}
			onWay={(id, way) => void pick(id, way)}
			onCancel={(id) => void cancel(id)}
			more={
				<>
					<button
						type="button"
						className="mt-3 text-ui text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
						onClick={() => setMore({ kind: "choose" })}
					>
						More providers, or a server of your own
					</button>
					<AddProvider
						open={more !== undefined}
						onOpenChange={(open) => setMore(open ? (more ?? { kind: "choose" }) : undefined)}
						step={more}
						providers={providers}
						here={!runsOnDevice}
						actions={actions}
						useOnSave
					/>
				</>
			}
		/>
	);
}
