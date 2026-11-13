/** Settings: the page, each of its tabs, and the provider accounts the band thinks with. */
import { useContext, useState } from "react";
import { type AddProviderActions, AddProviderSteps } from "../../chat/AddProvider.tsx";
import { Band } from "../../chat/Band.tsx";
import { CustomProviders } from "../../chat/CustomProviders.tsx";
import { ServerSetup } from "../../chat/ServerSetup.tsx";
import { AppSettings, ModelProviders, SettingsPage } from "../../chat/Settings.tsx";
import { UsagePanel } from "../../chat/Usage.tsx";
import type { Tier, TiersView } from "../../lib/api.ts";
import {
	ADD_PROVIDERS,
	ATLAS,
	CUSTOM_PROVIDERS,
	ROWS,
	SANCHO,
	SERVER_LISTING,
	SETTINGS,
	SETTINGS_PROVIDERS,
	TOGETHER_CATALOG,
} from "../fixtures.ts";
import { Section, StageContext } from "../stage.tsx";

/** The dialog's daemon, as fixtures: nothing leaves the page. */
const FIXTURE_ACTIONS: AddProviderActions = {
	catalog: async () => TOGETHER_CATALOG,
	refresh: async () => TOGETHER_CATALOG,
	connect: async () => ({}),
	providers: async () => ADD_PROVIDERS,
	answer: async () => undefined,
	cancel: async () => undefined,
	start: async () => undefined,
	list: async () => SERVER_LISTING,
	saveServer: async () => "custom-ollama",
	use: async () => undefined,
};

const example = {
	input: 120_000,
	output: 8_240,
	cacheRead: 640_000,
	cacheWrite: 40_000,
	estimatedUsd: 8.43,
	cacheReadRate: 0.8,
};
const usage = (
	<UsagePanel
		agent={(id) => {
			const one = id === "atlas" ? ATLAS : SANCHO;
			return { name: one.name, face: one.face };
		}}
		report={{
			total: example,
			byAgent: [
				{
					...example,
					id: "sancho",
					input: 90_000,
					output: 7_000,
					cacheRead: 600_000,
					cacheWrite: 10_000,
					estimatedUsd: 6.2,
					cacheReadRate: 6 / 7,
				},
				{
					...example,
					id: "atlas",
					input: 30_000,
					output: 1_240,
					cacheRead: 40_000,
					cacheWrite: 30_000,
					estimatedUsd: 2.23,
					cacheReadRate: 0.4,
				},
			],
			byProvider: [{ ...example, id: "anthropic" }],
			byModel: [{ ...example, id: "anthropic/claude-sonnet-5-5" }],
			system: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedUsd: 0, cacheReadRate: null },
		}}
	/>
);

const defaultModels: TiersView["models"] = {
	quick: { id: "claude-haiku-5-5", name: SETTINGS.models.quick },
	balanced: { id: "claude-sonnet-5-5", name: SETTINGS.models.balanced },
	deep: { id: "claude-opus-5-5", name: SETTINGS.models.deep },
};
const catalog = Object.values(defaultModels);

function SettingsExample({ tab }: { tab?: "model" | "usage" | "connections" | "agents" }) {
	const [models, setModels] = useState(defaultModels);
	const onChange = (tier: Tier, id: string | null) => {
		const selected = catalog.find((one) => one.id === id);
		setModels((prior) => ({
			...prior,
			[tier]:
				selected === undefined || selected.id === defaultModels[tier].id
					? defaultModels[tier]
					: { ...selected, own: true },
		}));
	};
	return (
		<AppSettings
			{...(tab === undefined ? {} : { tab })}
			data={{ ...SETTINGS, archived: [{ ...ATLAS, when: "2 Oct" }] }}
			tierModels={{ models, catalog, onChange }}
			usage={usage}
			providers={<ModelProviders current="anthropic" providers={SETTINGS_PROVIDERS} />}
		/>
	);
}

export function SettingsSections() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	return (
		<>
			<Section id="settings" note="General, Model, Usage, Connections and Agents, as in the app." bleed>
				{phone ? null : <Band rows={ROWS} />}
				<SettingsPage title="Settings" phone={phone}>
					<SettingsExample />
				</SettingsPage>
			</Section>
			<Section id="settings-tabs" note="Model, Usage, Connections and Agents, as each opens.">
				{(["model", "usage", "connections", "agents"] as const).map((tab) => (
					<div key={tab} className="h-[30rem] overflow-hidden rounded-tile border border-line-soft">
						<SettingsPage title="Settings" phone={phone}>
							<SettingsExample tab={tab} />
						</SettingsPage>
					</div>
				))}
			</Section>
			<Section
				id="settings-providers"
				note="Every provider account the band may think with, in each state; adding, renaming and signing out."
			>
				<SettingsPage title="Settings" phone={phone}>
					<ModelProviders current="anthropic" providers={SETTINGS_PROVIDERS} open="mistral" />
				</SettingsPage>
				<SettingsPage title="Settings, adding an account" phone={phone}>
					<ModelProviders current="anthropic" providers={SETTINGS_PROVIDERS} adding="anthropic" />
				</SettingsPage>
				<SettingsPage title="Settings, renaming an account" phone={phone}>
					<ModelProviders
						current="anthropic"
						providers={SETTINGS_PROVIDERS}
						onRename={() => {}}
						renaming="anthropic@work"
					/>
				</SettingsPage>
				<SettingsPage title="Settings, adding a keyed account" phone={phone}>
					<ModelProviders
						current="anthropic"
						providers={[{ id: "mistral", name: "Mistral", by: "key", connected: true }]}
						adding="mistral"
					/>
				</SettingsPage>
				<SettingsPage title="Settings, on a device" phone={phone}>
					<ModelProviders current="anthropic" providers={SETTINGS_PROVIDERS} here={false} />
				</SettingsPage>
			</Section>
			<Section
				id="settings-custom-providers"
				note="Add a provider: every provider pi-ai supports and servers of the owner's; a cloud's own form; a catalog to start from; a server's listed models, kept apart from the one it starts on; saved, then Use. The owner's servers, each with where it sends things."
			>
				<SettingsPage title="Add a provider" phone={phone}>
					<AddProviderSteps providers={ADD_PROVIDERS} actions={FIXTURE_ACTIONS} onDone={() => {}} />
				</SettingsPage>
				<SettingsPage title="A cloud's own form" phone={phone}>
					<AddProviderSteps
						providers={ADD_PROVIDERS}
						actions={FIXTURE_ACTIONS}
						step={{ kind: "builtin", id: "cloudflare-ai-gateway" }}
						onDone={() => {}}
					/>
				</SettingsPage>
				<SettingsPage title="Starting a provider without a preset" phone={phone}>
					<AddProviderSteps
						providers={ADD_PROVIDERS}
						actions={FIXTURE_ACTIONS}
						step={{ kind: "builtin", id: "together" }}
						onDone={() => {}}
					/>
				</SettingsPage>
				<SettingsPage title="A server's models, found" phone={phone}>
					<ServerSetup kind="ollama" listing={SERVER_LISTING} list={FIXTURE_ACTIONS.list} />
				</SettingsPage>
				<SettingsPage title="Saved, not used" phone={phone}>
					<AddProviderSteps
						providers={ADD_PROVIDERS}
						actions={FIXTURE_ACTIONS}
						step={{
							kind: "saved",
							id: "together",
							name: "Together",
							what: "Connected. It starts on Qwen3 235B for every tier; you can refine each later.",
						}}
						onDone={() => {}}
					/>
				</SettingsPage>
				<SettingsPage title="Your own servers" phone={phone}>
					<CustomProviders view={{ providers: CUSTOM_PROVIDERS }} current="custom-ollama" />
				</SettingsPage>
				<SettingsPage title="Your own servers, on a phone" phone={phone}>
					<CustomProviders view={{ providers: CUSTOM_PROVIDERS }} current="anthropic" here={false} />
				</SettingsPage>
			</Section>
		</>
	);
}
