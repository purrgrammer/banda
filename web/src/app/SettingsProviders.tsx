/**
 * Settings' providers, live: every provider the band may think with, read from the daemon while the Model tab shows,
 * to connect, use or sign out of. The tiers follow the one in use.
 */
import { useProviderConnect } from "../areas/tiers.ts";
import { ModelProviders } from "../chat/Settings.tsx";

export function SettingsProviders({ current }: { current: string }) {
	const { providers, open, waiting, error, pick, key, use, signOut } = useProviderConnect();
	return (
		<ModelProviders
			current={current}
			providers={providers.map((provider) => ({
				id: provider.id,
				name: provider.name,
				by: provider.oauth ? ("sign-in" as const) : ("key" as const),
				connected: provider.connected,
				connecting: provider.connecting,
				...(provider.error === undefined ? {} : { error: provider.error }),
			}))}
			open={open}
			waiting={waiting}
			error={error}
			onUse={(id) => void use(id)}
			onConnect={(id) => void pick(id)}
			onKey={(id, value) => void key(id, value)}
			onSignOut={(id) => void signOut(id)}
		/>
	);
}
