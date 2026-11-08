/**
 * Settings' providers, live: every provider account the band may think with, read from the daemon while the Model tab
 * shows, to connect, use, sign out of, rename or add another to. The tiers follow the one in use. On a device, the connected
 * ones alone: a sign-in comes back to the computer banda runs on.
 */
import { useProviderConnect, wayLabel } from "../areas/tiers.ts";
import { ModelProviders } from "../chat/Settings.tsx";
import { runsOnDevice } from "../lib/api.ts";

export function SettingsProviders({ current }: { current: string }) {
	const { providers, open, waiting, error, pick, answer, cancel, key, use, signOut, add, rename } =
		useProviderConnect();
	return (
		<ModelProviders
			current={current}
			here={!runsOnDevice}
			providers={providers.flatMap((provider) =>
				provider.accounts.map((account) => ({
					id: account.id,
					name: provider.name,
					provider: provider.id,
					label: account.label,
					by: provider.oauth ? ("sign-in" as const) : ("key" as const),
					connected: account.connected,
					...(account.ambient === true ? { ambient: true as const } : {}),
					...(account.source === undefined ? {} : { source: account.source }),
					connecting: account.connecting,
					asks: account.question !== undefined,
					ways: account.methods?.map((way) => ({ id: way.id, label: wayLabel(way) })),
					way: account.method,
					...(account.error === undefined ? {} : { error: account.error }),
				})),
			)}
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
			onAdd={(provider, label, value) => void add(provider, label, value)}
			onRename={(id, label) => void rename(id, label)}
		/>
	);
}
