/** Settings: the page, each of its tabs, and the provider accounts the band thinks with. */
import { useContext } from "react";
import { Band } from "../../chat/Band.tsx";
import { AppSettings, ModelProviders, SettingsPage } from "../../chat/Settings.tsx";
import { ATLAS, ROWS, SETTINGS, SETTINGS_PROVIDERS } from "../fixtures.ts";
import { Section, StageContext } from "../stage.tsx";

export function SettingsSections() {
	const { width } = useContext(StageContext);
	const phone = width === "phone";
	return (
		<>
			<Section
				id="settings"
				note="One page in four tabs, as the agent's panel has them: General, Model, Connections, Agents."
				bleed
			>
				{phone ? null : <Band rows={ROWS} />}
				<SettingsPage title="Settings" phone={phone}>
					<AppSettings data={{ ...SETTINGS, archived: [{ ...ATLAS, when: "2 Oct" }] }} />
				</SettingsPage>
			</Section>
			<Section id="settings-tabs" note="Model, Connections and Agents, as each opens.">
				{(["model", "connections", "agents"] as const).map((tab) => (
					<div key={tab} className="h-[30rem] overflow-hidden rounded-tile border border-line-soft">
						<SettingsPage title="Settings" phone={phone}>
							<AppSettings
								tab={tab}
								data={{ ...SETTINGS, archived: [{ ...ATLAS, when: "2 Oct" }] }}
								providers={<ModelProviders current="anthropic" providers={SETTINGS_PROVIDERS} />}
							/>
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
		</>
	);
}
