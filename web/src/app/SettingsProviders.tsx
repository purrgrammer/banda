/**
 * Settings' providers, live: the provider accounts the owner connected, to use, sign out of, rename or add another to,
 * and Add a provider, every provider banda can think with and servers of the owner's (`../chat/AddProvider.tsx`). The
 * tiers follow the one in use. On a device, the connected ones and Add a provider: a sign-in there comes back to the
 * computer banda runs on, so the dialog says to sign in there.
 */
import { PlusIcon } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	addCustomProvider,
	connectOnly,
	listServerModels,
	readCatalog,
	refreshCatalog,
	serversChanged,
	startProvider,
} from "../areas/custom-providers.ts";
import {
	answerSignIn,
	cancelSignIn,
	changeModels,
	readProviders,
	readTiers,
	useProviderConnect,
	wayLabel,
} from "../areas/tiers.ts";
import { AddProvider, type AddProviderActions } from "../chat/AddProvider.tsx";
import { ModelProviders } from "../chat/Settings.tsx";
import { runsOnDevice } from "../lib/api.ts";

/** What Add a provider asks of the daemon, from Settings and first run alike. */
export function useAddProviderActions(): AddProviderActions {
	return useMemo<AddProviderActions>(
		() => ({
			catalog: readCatalog,
			refresh: refreshCatalog,
			connect: connectOnly,
			providers: readProviders,
			answer: answerSignIn,
			cancel: cancelSignIn,
			start: async (provider, model) => {
				await startProvider(provider, model);
				await readTiers();
			},
			list: listServerModels,
			saveServer: async (save) => {
				const { id } = await addCustomProvider(save);
				serversChanged();
				return id;
			},
			use: async (id) => {
				try {
					await changeModels({ provider: id });
					await readTiers();
					serversChanged();
					return undefined;
				} catch (thrown) {
					return thrown instanceof Error ? thrown.message : String(thrown);
				}
			},
		}),
		[],
	);
}

export function SettingsProviders({
	current,
	servers = [],
	serverRows,
}: {
	current: string;
	/** The owner's servers' names, which a new one must not repeat. */
	servers?: readonly string[];
	/** The owner's servers, as rows of the providers' list. */
	serverRows?: ReactNode;
}) {
	const { providers, open, waiting, error, pick, answer, cancel, key, use, signOut, add, rename } =
		useProviderConnect();
	const [adding, setAdding] = useState(false);
	const opener = useRef<HTMLElement | null>(null);
	const actions = useAddProviderActions();
	// the accounts the owner connected, or is connecting, or that failed and are theirs to retry or remove
	const rows = providers.flatMap((provider) =>
		provider.accounts
			.filter((account) => account.connected || account.connecting || account.error !== undefined)
			.map((account) => ({
				id: account.id,
				name: provider.name,
				provider: provider.id,
				label: account.label,
				by: provider.oauth ? ("sign-in" as const) : ("key" as const),
				connected: account.connected,
				...(account.signedIn === true ? { signedIn: true } : {}),
				...(account.ambient === true ? { ambient: true as const } : {}),
				...(account.source === undefined ? {} : { source: account.source }),
				connecting: account.connecting,
				asks: account.question !== undefined,
				ways: account.methods?.map((way) => ({ id: way.id, label: wayLabel(way) })),
				way: account.method,
				...(account.error === undefined ? {} : { error: account.error }),
			})),
	);
	return (
		<>
			<ModelProviders
				current={current}
				here={!runsOnDevice}
				providers={rows}
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
				{...(serverRows === undefined ? {} : { servers: serverRows })}
				add={
					<Button
						variant="outline"
						size="sm"
						className="self-start"
						aria-label="Add a provider"
						onClick={(event) => {
							opener.current = event.currentTarget;
							setAdding(true);
						}}
					>
						<PlusIcon />
						Add a provider
					</Button>
				}
			/>
			<AddProvider
				open={adding}
				onOpenChange={setAdding}
				providers={providers}
				servers={servers}
				here={!runsOnDevice}
				actions={actions}
				onCloseAutoFocus={(event) => {
					if (opener.current?.isConnected !== true) return;
					event.preventDefault();
					opener.current.focus();
				}}
			/>
		</>
	);
}
