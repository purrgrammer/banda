/**
 * Settings' providers, live: every provider the band may think with, read from the daemon while the Model tab shows,
 * to connect, use or sign out of. The tiers follow the one in use. On a device, the connected ones alone: a sign-in
 * comes back to the computer banda runs on.
 */
import { useProviderConnect, wayLabel } from "../areas/tiers.ts";
import { ModelProviders } from "../chat/Settings.tsx";
import { runsOnDevice } from "../lib/api.ts";

export function SettingsProviders({ current }: { current: string }) {
	const { providers, open, waiting, error, pick, answer, cancel, key, use, signOut } = useProviderConnect();
	return (
		<ModelProviders
			current={current}
			here={!runsOnDevice}
			providers={providers.map((provider) => ({
				id: provider.id,
				name: provider.name,
				by: provider.oauth ? ("sign-in" as const) : ("key" as const),
				connected: provider.connected,
				...(provider.ambient === true ? { ambient: true as const } : {}),
				...(provider.source === undefined ? {} : { source: provider.source }),
				connecting: provider.connecting,
				asks: provider.question !== undefined,
				ways: provider.methods?.map((way) => ({ id: way.id, label: wayLabel(way) })),
				way: provider.method,
				...(provider.error === undefined ? {} : { error: provider.error }),
			}))}
			open={open}
			waiting={waiting}
			error={error}
			onUse={(id) => void use(id)}
			onConnect={(id) => void pick(id)}
			onKey={(id, value) => void key(id, value)}
			onSignOut={(id) => void signOut(id)}
			onAnswer={(id, value) => void answer(id, value)}
			onWay={(id, way) => void pick(id, way)}
			onCancel={(id) => void cancel(id)}
		/>
	);
}
