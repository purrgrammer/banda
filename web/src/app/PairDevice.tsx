/**
 * The native shell's first screen until this phone is a paired device (`lib/pairing.ts`): it reads where the shell
 * stands, pairs when it must, and opens the app once the owner approved this phone. In a browser it is never shown.
 */
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { PairPhone } from "../chat/PairPhone.tsx";
import { api, onDeviceRefused, type PairingView } from "../lib/api.ts";
import { type Pairing, pairing } from "../lib/pairing.ts";
import type { BandaPlugin, ScannerPlugin } from "../lib/transport.ts";

export function PairDevice({
	shell,
	children,
}: {
	shell: { readonly banda: BandaPlugin; readonly scanner?: ScannerPlugin };
	/** The app, once paired. */
	children: ReactNode;
}) {
	const [flow] = useState<Pairing>(() =>
		pairing({
			shell: shell.banda,
			scanner: shell.scanner,
			ask: async (invite, name) =>
				(await api<PairingView>("/devices/pair", { method: "POST", body: JSON.stringify({ invite, name }) })).state,
			check: async () => (await api<PairingView>("/devices/pair")).state,
		}),
	);
	const step = useSyncExternalStore(flow.subscribe, flow.get);
	useEffect(() => {
		void flow.start().catch(() => undefined);
		const listening = shell.banda.addListener("link", ({ url }) => flow.opened(url));
		return () => {
			flow.stop();
			void listening.then((handle) => handle.remove()).catch(() => undefined);
		};
	}, [flow, shell]);
	useEffect(() => {
		const stopListening = onDeviceRefused(() => void flow.refused());
		return () => {
			stopListening();
		};
	}, [flow]);
	if (step.step === "paired") return children;
	return (
		<PairPhone
			step={step}
			onScan={(name) => void flow.scan(name)}
			onPairLink={(name) => {
				if (step.step === "scan" && step.link !== undefined) void flow.pair(step.link, name);
			}}
			onConfirm={() => void flow.confirm()}
			onAgain={flow.again}
			onRetry={() => void flow.start().catch(() => undefined)}
		/>
	);
}
