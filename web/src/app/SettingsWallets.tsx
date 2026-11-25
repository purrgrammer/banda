/**
 * Settings' wallets, live: every wallet with its balance and its one mark, archived ones beneath, New wallet, and each
 * network's RPC, shown only masked (H-195): a change is typed fresh and answered masked. A paired device makes wallets
 * too (its key is then seen on the computer, H-276); an RPC is set only on the computer banda runs on. Where the daemon
 * found no keychain it can use, the reason and its fix stand in place of New wallet (H-309). On the computer, the keys
 * its keychain holds that no wallet names are listed when the owner looks for them (H-045); in banda's desktop app each can be exported, and deleted
 * once the owner confirms, both after the computer asks it's the owner, the key never coming to this page.
 */
import { useState } from "react";
import { toast } from "sonner";
import { checkKeychain, readOrphans, setRpc, useWallets } from "../areas/wallets.ts";
import { type RpcEditing, WalletsSettings } from "../chat/Wallets.tsx";
import { Refused, runsOnDevice } from "../lib/api.ts";
import { attempt, failureWords, sayFailed } from "../lib/attempt.ts";
import { desktop, laterKey } from "../lib/desktop.ts";
import type { ChatAgent } from "../lib/navigation.ts";
import { useNow } from "../lib/now.ts";
import { whoOf } from "./band.ts";
import { desktopAct } from "./desktop-act.ts";
import { useSaveReminder, WALLET_TICK } from "./WalletPages.tsx";
import { rpcRows, shownWallet } from "./wallets.ts";
import { hrefOf } from "./where.ts";

/** `agents`: every agent of the band, archived ones too, which the wallets name by their faces. */
export function SettingsWallets({ agents }: { agents: readonly ChatAgent[] }) {
	const view = useWallets();
	const now = useNow(WALLET_TICK);
	const [editing, setEditing] = useState<RpcEditing | undefined>(undefined);
	const [orphans, setOrphans] = useState<readonly string[]>([]);
	const [orphanSearch, setOrphanSearch] = useState<"finding" | "none" | "unlisted" | undefined>(undefined);
	useSaveReminder(view?.wallets, view?.networks);
	// listing the keychain loads every item of its service, every home's keys with them, and may prompt once per item:
	// only when the owner asks, never on opening this page nor on a wallet made or removed (H-009, H-037)
	const findOrphans = () => {
		setOrphanSearch("finding");
		void readOrphans().then(
			(answer) => {
				setOrphans(answer.orphans ?? []);
				setOrphanSearch(answer.orphans === null ? "unlisted" : answer.orphans.length === 0 ? "none" : undefined);
			},
			(error: unknown) => {
				setOrphanSearch(undefined);
				sayFailed("look for keys without a wallet", error, findOrphans);
			},
		);
	};
	// both are behind the OS's re-authentication, which a computer without it refuses (H-266): offered only where it asks
	const owner = runsOnDevice || laterKey !== "here" ? undefined : desktop;
	const exporting = owner?.exportOrphan;
	const deleting = owner?.deleteOrphan;
	if (view === undefined) return null;
	const shown = view.wallets.map((wallet) => ({
		wallet,
		shown: shownWallet(wallet, view, (id) => whoOf(agents, id), now),
	}));
	const save = (network: string, url: string | null) => {
		setEditing({ network, busy: true });
		void setRpc(network, url).then(
			(after) => {
				setEditing(undefined);
				toast.success(`${after.label} now reads through ${after.rpc ?? "no RPC"}`);
			},
			(error: unknown) =>
				setEditing({ network, error: error instanceof Refused ? error.message : failureWords(error) }),
		);
	};
	return (
		<WalletsSettings
			wallets={shown.filter(({ wallet }) => wallet.state !== "archived").map((each) => each.shown)}
			archived={shown.filter(({ wallet }) => wallet.state === "archived").map((each) => each.shown)}
			orphans={orphans}
			onFindOrphans={runsOnDevice ? undefined : findOrphans}
			orphanSearch={orphanSearch}
			onExportOrphan={
				exporting === undefined
					? undefined
					: (address) =>
							void desktopAct({ what: "show the key", refused: "The key wasn't shown", run: () => exporting(address) })
			}
			onDeleteOrphan={
				deleting === undefined
					? undefined
					: (address) =>
							void desktopAct({
								what: "delete the key",
								refused: "The key wasn't deleted",
								run: () => deleting(address),
								onDone: () => {
									toast.success("The key was deleted from your keychain");
									// taken off the list as it is, never by listing the keychain again
									setOrphans((before) => before.filter((each) => each !== address));
								},
							})
			}
			rpc={rpcRows(view.networks, now)}
			hostMode={view.offline === "host_mode"}
			keychain={view.keychain ?? "ready"}
			// a check reads the computer's keychain, which may prompt there: a paired device shows what was last found
			onCheckKeychain={runsOnDevice ? undefined : () => void attempt("check the keychain", checkKeychain)}
			onCreate={() => {
				location.hash = hrefOf({ name: "wallet" });
			}}
			onOpen={(address) => {
				location.hash = hrefOf({ name: "wallet", address });
			}}
			rpcHere={!runsOnDevice}
			editing={editing}
			onChangeRpc={(network) => setEditing({ network })}
			onSaveRpc={(network, url) => save(network, url)}
			onDefaultRpc={(network) => save(network, null)}
			onCancelRpc={() => setEditing(undefined)}
		/>
	);
}
