/**
 * A wallet's pages, live (docs/wallets.md, UC-01 to UC-05, UC-14 A3): making one and saving its key, one wallet opened
 * (its balance, notices, the money that came in, its agents and own settings), saving its key later, and Receive.
 *
 * The key reaches this page once, right after the creation, with the secret only the creation's answer carries (C16):
 * the page shows it for 30 seconds at a time (H-270), and drops it when the owner switches away, once the copy is
 * checked, and with the page (H-274); a copy on the clipboard is cleared a minute later wherever the app is by then
 * (H-271). Later only banda's desktop app shows it, in a window of its own (OD-2); a paired device never sees it.
 */

import { KeyRoundIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { normalKey } from "../../../src/wallet/key-text.ts";
import { shortAddress } from "../../../src/wallet/label.ts";
import {
	acknowledgeCode,
	archiveWallet,
	checkKeychain,
	checkWallet,
	confirmSaved,
	createWallet,
	creationId,
	forAgentOnceSaved,
	openReceive,
	readIncoming,
	readWallets,
	removeWallet,
	revealCreated,
	skipSaving,
	switchWalletAgent,
	useLooking,
	useWallets,
} from "../areas/wallets.ts";
import { Confirm } from "../chat/Confirm.tsx";
import { SettingsPage } from "../chat/Settings.tsx";
import {
	AgentWallets,
	ArchivedNotice,
	archiveWords,
	type CreateState,
	CreateWallet,
	NoWallet,
	OFFLINE,
	OfflineNotice,
	type OfflineReason,
	Receive,
	type ReceiveState,
	RemoveRefused,
	RemovingNotice,
	RestoreKey,
	type RestoreState,
	type RpcView,
	removeWords,
	SaveKey,
	type SaveKeyStep,
	type ShownWallet,
	TransactionList,
	UNSAVED_DISCLOSED,
	unopenable,
	WalletAgents,
	WalletNotice,
	WalletOptions,
	WalletPage,
	type WalletParent,
	type WalletTab,
	WhichWallet,
} from "../chat/Wallets.tsx";
import {
	Refused,
	runsOnDevice,
	type WalletCreate,
	type WalletIncoming,
	type WalletMade,
	type WalletsView,
	type WalletView,
} from "../lib/api.ts";
import { attempt, failureWords, sayFailed } from "../lib/attempt.ts";
import { desktop, laterKey } from "../lib/desktop.ts";
import type { ChatAgent } from "../lib/navigation.ts";
import { useNow } from "../lib/now.ts";
import { whoOf } from "./band.ts";
import { clearsWithPage, clipboard } from "./clipboard.ts";
import { desktopAct } from "./desktop-act.ts";
import {
	activityRows,
	choices,
	createdReason,
	createdState,
	firstReminder,
	firstSaveStep,
	incompleteOf,
	keyDigest,
	keySaves,
	labelOf,
	nameTaken,
	offlineOf,
	type ReminderStore,
	remindsToSave,
	rpcRows,
	savesOnOpen,
	shownWallet,
	unswitchable,
	wrongCopy,
} from "./wallets.ts";
import { hrefOf, OFFERED_TABS, routedTo, routesTo, type WalletPage as Subpage, type Where } from "./where.ts";

const go = (where: Where) => {
	location.hash = hrefOf(where);
};

/**
 * The desktop app's acts behind the OS's re-authentication (a later reveal, a Restore, a move of signing), where this
 * computer can ask who the owner is: elsewhere the app refuses each (OD-2, H-266), so no screen offers them.
 */
const behindOwner = laterKey === "here" && !runsOnDevice ? desktop : undefined;

/** Settings → Wallets, which every wallet page goes back to. */
const WALLETS: Where = { name: "settings", tab: "wallets" };
const toWallets: WalletParent = { title: "Wallets", href: hrefOf(WALLETS), onBack: () => go(WALLETS) };
const toWallet = (wallet: Pick<WalletView, "address" | "name">): WalletParent => {
	const where: Where = { name: "wallet", address: wallet.address };
	return { title: wallet.name, href: hrefOf(where), onBack: () => go(where) };
};

/**
 * How often a wallet screen reads the time its readings' ages are said by, so "just now" stays true between the
 * daemon's pushes, which come only when a read of the chain changed something or a minute has passed.
 */
export const WALLET_TICK = 30_000;

/** How often Receive asks again while its check could not be made (the network or the keychain not answering). */
const RECEIVE_RETRY_MS = 5_000;

/** This device's storage, or none where reaching it throws. */
function deviceStore(): ReminderStore | undefined {
	try {
		return localStorage;
	} catch {
		return undefined;
	}
}

/**
 * One reminder per wallet, ever, on this device, when a wallet whose key is not saved first holds more than a little
 * (H-273): the row's quiet Not backed up mark says the rest, never a nag.
 */
export function useSaveReminder(
	wallets: readonly WalletView[] | undefined,
	networks: WalletsView["networks"] | undefined,
): void {
	useEffect(() => {
		if (wallets === undefined) return;
		for (const wallet of wallets) {
			if (!remindsToSave(wallet) || !firstReminder(wallet.address, deviceStore())) continue;
			// names are not unique: the reminder says which wallet by its short address and network too (H-041)
			toast(`${wallet.name} holds money, and its key isn't saved`, {
				id: `remind-${wallet.address}`,
				description: `${which(wallet, networks)}. If this computer is lost, so is what's in it. Save a copy of its key.`,
				duration: 20_000,
				...(runsOnDevice
					? {}
					: {
							action: {
								label: "Save your key",
								onClick: () => go({ name: "wallet", address: wallet.address, page: "key" }),
							},
						}),
			});
		}
	}, [wallets, networks]);
}

/** Which wallet a note is about, as its row tells it: its short address and its network (H-041). */
const which = (wallet: WalletView, networks: WalletsView["networks"] | undefined) =>
	`${shortAddress(wallet.address)} on ${labelOf(networks ?? [], wallet.network)}`;

/**
 * At the app's open on the computer, the Save your key step of each wallet a paired device made, whose key it could
 * not show (UC-01 A3, H-276): one prompt per wallet, kept on this computer as the reminder is, which opens the step.
 * A paired device shows none: the key is seen on the computer alone. The shell runs it, so the save reminder (H-273)
 * runs here too, on the computer: a wallet funded while the owner is in a chat reminds them there, when its balance
 * first passes the threshold, not when a wallet screen next opens.
 */
export function useSaveStep(): void {
	const view = useWallets();
	const wallets = view?.wallets;
	const networks = view?.networks;
	useSaveReminder(runsOnDevice ? undefined : wallets, networks);
	useEffect(() => {
		if (wallets === undefined || runsOnDevice || view?.offline === "identity") return;
		for (const wallet of wallets) {
			if (!savesOnOpen(wallet) || !firstSaveStep(wallet.address, deviceStore())) continue;
			toast(`Save ${wallet.name}'s key`, {
				id: `save-step-${wallet.address}`,
				description: `${which(wallet, networks)} was made on a paired device, which never shows a key: see it here and save a copy.`,
				duration: Number.POSITIVE_INFINITY,
				action: {
					label: "Save your key",
					onClick: () => go({ name: "wallet", address: wallet.address, page: "key" }),
				},
			});
		}
	}, [wallets, networks, view?.offline]);
}

/** How long the key shows before it hides again (H-270). */
const SHOWN_MS = 30_000;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** The seconds until a copied key leaves the clipboard, while it is on it. */
const useClears = () => useSyncExternalStore(clipboard.subscribe, clipboard.left);

/**
 * Checking a pasted copy, sent as its SHA-256 alone: on to `saved`, or `wrong` when it does not open the wallet, which
 * then stays Not backed up; the error when the check did not happen.
 */
async function checkCopy(
	address: string,
	digest: string,
): Promise<{ readonly after: "saved" | "wrong" } | { readonly error: unknown }> {
	try {
		await confirmSaved(address, digest);
		return { after: "saved" };
	} catch (error) {
		if (wrongCopy(error instanceof Refused ? error : undefined)) return { after: "wrong" };
		return { error };
	}
}

/** Whether a reveal's refusal says it is gone for good: the daemon's 403, spent, expired or never this page's (C16). */
export const spent = (error: unknown): boolean => error instanceof Refused && error.status === 403;

/**
 * The screen kept from screen capture while a key is on it (H-270), where the desktop app can do that; off again when
 * it leaves, and with the page.
 */
function useProtected(on: boolean): void {
	useEffect(() => {
		const protect = desktop?.protectScreen;
		if (!on || protect === undefined) return;
		void protect(true).catch(() => {});
		return () => void protect(false).catch(() => {});
	}, [on]);
}

/**
 * The steps of saving a key, from `start`, shared by a new wallet's page and the later one.
 */
function useSaving(address: string | undefined, start: SaveKeyStep) {
	const [step, setShown] = useState<SaveKeyStep>(start);
	const [pasted, setPasted] = useState("");
	/**
	 * On to `next`: a pasted copy, right or wrong, is kept only while the step that checks it shows it (`wrong` keeps it
	 * to be mended), so a key pasted later is never added to an old one, and none stays in the page (H-274, H-275).
	 */
	const setStep = useCallback((next: SaveKeyStep) => {
		if (next !== "wrong") setPasted("");
		setShown(next);
	}, []);
	const [busy, setBusy] = useState(false);
	/** The last copy checked had spaces in it, which the check left out: said on the step after, never over its buttons. */
	const [spaced, setSpaced] = useState(false);
	/** A check sent as the copy's digest alone: Try again sends that digest again, and the pasted text is not kept. */
	const send = (at: string, digest: string) => {
		setBusy(true);
		void checkCopy(at, digest)
			.then((answer) => {
				if ("error" in answer) {
					sayFailed("check your copy", answer.error, () => send(at, digest));
					return;
				}
				setStep(answer.after);
			})
			.finally(() => setBusy(false));
	};
	const check = () => {
		if (address === undefined) return;
		// a copy with spaces is checked without them, and said so on the step it leads to: wallet apps take the key with none
		setSpaced(/\s/.test(pasted.trim()));
		void keyDigest(pasted).then(
			(digest) => send(address, digest),
			() =>
				toast.error("Couldn't check your copy", {
					description: "This page can't check a key here. Open banda at its own address, or in its desktop app.",
				}),
		);
	};
	const skip = () => {
		if (address === undefined) return;
		setBusy(true);
		void attempt("skip saving the key", () => skipSaving(address))
			.then((view) => {
				if (view !== undefined) go({ name: "wallet", address });
			})
			.finally(() => setBusy(false));
	};
	return { step, setStep, pasted, setPasted, busy, setBusy, spaced, check, skip };
}

/**
 * The key this page was given, while it may show it: hidden again 30 seconds after each Show, and dropped when the
 * window loses focus or the page is hidden.
 */
function useSecret() {
	const [secret, setSecret] = useState<string | undefined>(undefined);
	const [shownAt, setShownAt] = useState<number | undefined>(undefined);
	const show = useCallback(() => setShownAt(Date.now()), []);
	const drop = useCallback(() => {
		setSecret(undefined);
		setShownAt(undefined);
	}, []);
	useEffect(() => {
		if (secret === undefined) return;
		const hidden = () => {
			if (document.visibilityState === "hidden") drop();
		};
		addEventListener("blur", drop);
		addEventListener("pagehide", drop);
		document.addEventListener("visibilitychange", hidden);
		return () => {
			removeEventListener("blur", drop);
			removeEventListener("pagehide", drop);
			document.removeEventListener("visibilitychange", hidden);
		};
	}, [secret, drop]);
	useEffect(() => {
		if (shownAt === undefined) return;
		const tick = setInterval(() => {
			if (Date.now() - shownAt >= SHOWN_MS) setShownAt(undefined);
		}, 1000);
		return () => clearInterval(tick);
	}, [shownAt]);
	return { secret, hidden: shownAt === undefined, give: setSecret, show, drop };
}

/**
 * Making a wallet: its name and network, then right away its key, once, and the steps of saving it. `agent` is the
 * agent it is made for: a wallet is made on for no agent (UC-01, H-001), and that agent is switched on once the key's
 * save step ends (saved, or the save skipped), on this page or any later one, unless the owner unticked it.
 */
export function NewWallet({
	agents,
	agent,
	phone,
}: {
	agents: readonly ChatAgent[];
	agent?: string | undefined;
	phone: boolean;
}) {
	const view = useWallets();
	const request = useRef(creationId());
	const [name, setName] = useState("");
	const [network, setNetwork] = useState<string | undefined>(undefined);
	const [forAgentOn, setForAgentOn] = useState(true);
	const [state, setState] = useState<CreateState>("form");
	const [reason, setReason] = useState<OfflineReason | undefined>(undefined);
	const [made, setMade] = useState<WalletView | undefined>(undefined);
	const key = useSecret();
	/**
	 * The secret this creation's answer carried, while its reveal is unspent: the key is fetched with it only when the
	 * owner taps Show key, so a skip spends nothing and lists no showing (UC-02, H-266), and a window that loses focus
	 * before then drops nothing.
	 */
	const unspent = useRef<WalletMade["reveal"]>(undefined);
	const forAgent = agent === undefined ? undefined : agents.find((each) => each.id === agent);
	const saving = useSaving(made?.address, "intro");
	const clears = useClears();
	useProtected(key.secret !== undefined);
	const create = () => {
		const on = network ?? view?.networks[0]?.id;
		if (on === undefined || name.trim() === "") return;
		setState("creating");
		void (async () => {
			let wallet: WalletView;
			let reveal: WalletMade["reveal"];
			try {
				({ wallet, reveal } = await createWallet(request.current, name.trim(), on as WalletCreate["network"]));
			} catch (error) {
				const refused = error instanceof Refused ? error : undefined;
				const said = createdState(refused);
				setReason(createdReason(refused));
				setState(said ?? "form");
				if (said === undefined) sayFailed("make the wallet", error, create);
				return;
			}
			// the wallet exists now: a reload or a tab opened again lands on its key page, never a blank form that would
			// make a second one; the key itself stays in this page alone (C16)
			history.replaceState(history.state, "", hrefOf({ name: "wallet", address: wallet.address, page: "key" }));
			// the agent it is made for is switched on once its save step ends, whichever page that ends on (UC-01)
			if (forAgent !== undefined && forAgentOn) forAgentOnceSaved(wallet.address, forAgent.id, forAgent.name);
			// the key is shown, once the owner asks, with the secret only this creation's answer carried
			let step: SaveKeyStep = "intro";
			if (runsOnDevice) step = "elsewhere";
			else if (reveal === undefined) step = "refused";
			else unspent.current = reveal;
			void readWallets();
			setMade(wallet);
			saving.setStep(step);
		})();
	};
	useEffect(() => {
		if (saving.step === "saved") key.drop();
	}, [saving.step, key.drop]);
	/** Another home holds the lease: the desktop app moves signing here (UC-21 A1), and the wallet is made then. */
	const moving = behindOwner?.moveSigning;
	const move =
		moving === undefined
			? undefined
			: () =>
					void desktopAct({
						what: "move signing here",
						refused: "Signing wasn't moved here",
						run: moving,
						onDone: create,
					});
	if (made === undefined)
		return (
			<CreateWallet
				state={state}
				name={name}
				network={network ?? view?.networks[0]?.id}
				networks={choices(view?.networks ?? [])}
				forAgent={forAgent === undefined ? undefined : whoOf(agents, forAgent.id)}
				forAgentOn={forAgentOn}
				taken={nameTaken(name, view?.wallets ?? [])}
				phone={phone}
				parent={toWallets}
				// a paired device never shows the key, so only a browser on the computer is warned (H-272)
				inBrowser={desktop === undefined && !runsOnDevice}
				onName={setName}
				onNetwork={setNetwork}
				onForAgent={setForAgentOn}
				onCreate={create}
				reason={reason}
				onMove={move}
				onCancel={() => go(WALLETS)}
			/>
		);
	const shown =
		view === undefined
			? undefined
			: shownWallet(
					view.wallets.find((each) => each.address === made.address) ?? made,
					view,
					(id) => whoOf(agents, id),
					Date.now(),
				);
	if (shown === undefined) return null;
	const done = () => go({ name: "wallet", address: made.address });
	const showKey = () => {
		const reveal = unspent.current;
		if (key.secret !== undefined || reveal === undefined) {
			key.show();
			if (saving.step === "intro") saving.setStep("shown");
			return;
		}
		// past its ten minutes the reveal is gone whatever the daemon says: the secret goes, and the step says so
		if (Date.now() >= reveal.expires) {
			unspent.current = undefined;
			saving.setStep("closed");
			return;
		}
		saving.setBusy(true);
		void revealCreated(made.address, request.current, reveal.secret)
			.then(
				(shown) => {
					unspent.current = undefined;
					key.give(shown.key);
					key.show();
					saving.setStep("shown");
				},
				(error: unknown) => {
					// the daemon spends nothing it does not show: only its 403 says the reveal is gone (spent, expired or
					// never this page's). Anything else (a keychain locked, its prompt dismissed, no answer in time, a spend
					// not yet safe on disk, a dropped connection) leaves the secret live, and Show key tries again with it:
					// it is the creation's one showing of the key, and no later answer carries it (C16, C21, H-263)
					if (spent(error)) {
						unspent.current = undefined;
						saving.setStep("refused");
						return;
					}
					sayFailed("show the key", error, showKey);
				},
			)
			.finally(() => saving.setBusy(false));
	};
	return (
		<SaveKey
			step={saving.step}
			wallet={shown}
			secret={key.secret}
			hidden={key.hidden}
			phone={phone}
			parent={toWallet(made)}
			busy={saving.busy}
			pasted={saving.pasted}
			spaced={saving.spaced}
			{...(clears === undefined ? {} : { clears: clock(clears) })}
			clearsWithPage={clearsWithPage}
			inBrowser={desktop === undefined}
			laterKey={laterKey}
			onShow={showKey}
			// a phone never ends the save step: the key it skips was shown nowhere it can see (UC-26)
			{...(runsOnDevice ? {} : { onSkip: saving.skip })}
			onCopy={() => {
				const secret = key.secret;
				if (secret === undefined) return;
				void clipboard.copy(secret).then(
					() => saving.setStep("copied"),
					() =>
						toast.error("Couldn't copy the key", {
							description: "Select it and copy it yourself.",
							// at the top on a phone, clear of the step's buttons at the bottom
							...(phone ? { position: "top-center" as const } : {}),
						}),
				);
			}}
			onSaved={() => saving.setStep("check")}
			onPaste={saving.setPasted}
			onCheck={saving.check}
			onShowAgain={() => {
				key.show();
				saving.setStep("shown");
			}}
			onReceive={() => go({ name: "wallet", address: made.address, page: "receive" })}
			onDone={done}
			onCheckCopy={() => saving.setStep("check")}
		/>
	);
}

/**
 * Saving a wallet's key later, or seeing it again: in the desktop app, after the computer asks it's the owner, in a
 * window of its own, then the copy checked here; elsewhere, where to do it.
 */
function WalletKey({ address, agents, phone }: { address: string; agents: readonly ChatAgent[]; phone: boolean }) {
	const view = useWallets();
	const wallet = view?.wallets.find((each) => same(each.address, address));
	const saving = useSaving(
		wallet?.address ?? address,
		runsOnDevice ? "elsewhere" : behindOwner?.revealKey === undefined ? "app_only" : "confirm_host",
	);
	if (view === undefined) return null;
	if (wallet === undefined) return <Gone phone={phone} />;
	const shown = shownWallet(wallet, view, (id) => whoOf(agents, id), Date.now());
	// no key here to show or check while the wallet's key is offline: the step says why, with that reason's own act
	if (!keySaves(wallet, view.offline))
		return (
			<SettingsPage
				title="Save your key"
				icon={KeyRoundIcon}
				parent={{ title: wallet.name, href: hrefOf({ name: "wallet", address: wallet.address }) }}
				phone={phone}
				onBack={() => go({ name: "wallet", address: wallet.address })}
			>
				<Notices wallet={wallet} shown={shown} />
			</SettingsPage>
		);
	const confirm = () => {
		const reveal = behindOwner?.revealKey;
		if (reveal === undefined) return;
		saving.setBusy(true);
		void desktopAct({
			what: "show the key",
			refused: "The key wasn't shown",
			run: () => reveal(wallet.address),
			onDone: () => saving.setStep(wallet.backup === "saved" ? "saved" : "check"),
			onSettled: () => saving.setBusy(false),
		});
	};
	return (
		<SaveKey
			step={saving.step}
			wallet={shown}
			phone={phone}
			parent={toWallet(wallet)}
			laterKey={laterKey}
			busy={saving.busy}
			pasted={saving.pasted}
			spaced={saving.spaced}
			onPaste={saving.setPasted}
			onCheck={saving.check}
			onConfirm={confirm}
			// a phone never ends the save step: the key it skips was shown nowhere it can see (UC-26)
			{...(runsOnDevice ? {} : { onSkip: saving.skip })}
			onCheckCopy={() => saving.setStep("check")}
			onReceive={() => go({ name: "wallet", address, page: "receive" })}
			onDone={() => go({ name: "wallet", address })}
		/>
	);
}

/**
 * Restoring a wallet's key whose keychain item is gone (UC-19 A2): in banda's desktop app, the pasted copy goes to its
 * signer on this computer, kept only if it opens the wallet's address, and the daemon then checks the key again;
 * elsewhere, where to do it. The pasted text lives in this page alone, and goes once it was sent.
 */
function WalletRestore({ address, agents, phone }: { address: string; agents: readonly ChatAgent[]; phone: boolean }) {
	const view = useWallets();
	const [state, setState] = useState<RestoreState>(behindOwner?.restoreKey === undefined ? "elsewhere" : "form");
	const [pasted, setPasted] = useState("");
	const [busy, setBusy] = useState(false);
	const wallet = view?.wallets.find((each) => same(each.address, address));
	if (view === undefined) return null;
	if (wallet === undefined) return <Gone phone={phone} />;
	const restore = () => {
		const keep = behindOwner?.restoreKey;
		if (keep === undefined) return;
		// the copy as the save step's check reads it (spaces, a missing 0x, either case); the desktop app reads it so again
		const key = normalKey(pasted);
		if (key === undefined) {
			setState("not_a_key");
			return;
		}
		setBusy(true);
		void desktopAct({
			what: "restore the key",
			refused: "The key wasn't restored",
			run: () => keep(wallet.address, key),
			onDone: () => {
				setPasted("");
				setState("restored");
			},
			onRefused: (code) => {
				setPasted("");
				if (code === "not_a_key") setState("not_a_key");
				else if (code === "wrong_key") setState("wrong");
				else return false;
				return true;
			},
			onSettled: () => setBusy(false),
		});
	};
	return (
		<RestoreKey
			wallet={shownWallet(wallet, view, (id) => whoOf(agents, id), Date.now())}
			state={state}
			phone={phone}
			parent={toWallet(wallet)}
			pasted={pasted}
			busy={busy}
			onPaste={(text) => {
				setPasted(text);
				if (state === "wrong" || state === "not_a_key") setState("form");
			}}
			onRestore={restore}
			onDone={() => go({ name: "wallet", address: wallet.address })}
		/>
	);
}

/** Receive: the address once the daemon says it may be given out, or why not yet. */
export function WalletReceive({
	address,
	agents,
	phone,
}: {
	address: string;
	agents: readonly ChatAgent[];
	phone: boolean;
}) {
	const view = useWallets();
	const now = useNow(WALLET_TICK);
	const [state, setState] = useState<ReceiveState | undefined>(undefined);
	/** The address the daemon gave once it marked it disclosed: the only one copied. */
	const [given, setGiven] = useState<string | undefined>(undefined);
	const [acknowledged, setAcknowledged] = useState(false);
	const [copied, setCopied] = useState(false);
	const [tries, setTries] = useState(0);
	/** The next ask is the page's own, while it waits: what it shows stays until the answer. */
	const quiet = useRef(false);
	// money sent to the address shown here is read in seconds while Receive stays open (UC-03, UC-14)
	useLooking(given === undefined ? undefined : address);
	const wallet = view?.wallets.find((each) => same(each.address, address));
	/**
	 * Only a ready wallet gives out its address: an archived, removing or still-making one is said as such, and the
	 * daemon, which refuses it, is not asked (a refusal no Try again could mend); unarchived, it is asked then.
	 */
	const ready = wallet?.state === "ready";
	// biome-ignore lint/correctness/useExhaustiveDependencies: Try again asks again
	useEffect(() => {
		const asked = quiet.current;
		quiet.current = false;
		if (!asked) {
			setState(undefined);
			setGiven(undefined);
		}
		if (!ready) return;
		// the page's own asking again says nothing when it fails: Try again does
		const ask = asked
			? openReceive(address).catch(() => undefined)
			: attempt("open Receive", () => openReceive(address));
		void ask.then((answer) => {
			if (answer === undefined) return;
			// an address that is not the one asked for is never shown nor copied (H-261): the page says so
			if (answer.state === "ready" && !sameAddress(answer.address, address)) {
				setState("mismatch");
				return;
			}
			setState(answer.state);
			if (answer.state === "ready") setGiven(answer.address);
			setAcknowledged(answer.state === "code" && answer.acknowledged);
		});
	}, [address, tries, ready]);
	/**
	 * What Receive waits on when its check could not be made: the network answering again, or the wallet's key read
	 * again. The page asks again as soon as either moves, and every few seconds meanwhile, so the address shows once the
	 * check can be made, as the page says, with no Try again.
	 */
	const waiting = state === "unchecked" || state === "key_unchecked";
	const network = view?.networks.find((each) => each.id === wallet?.network);
	const health = JSON.stringify([
		network?.unread ?? null,
		network?.otherChain ?? null,
		network?.problem ?? null,
		wallet?.signing ?? null,
	]);
	const seen = useRef(health);
	useEffect(() => {
		if (!waiting) {
			seen.current = health;
			return;
		}
		const quietly = () => {
			quiet.current = true;
			setTries((n) => n + 1);
		};
		if (seen.current !== health) {
			seen.current = health;
			quietly();
		}
		const again = setInterval(() => {
			if (document.visibilityState !== "hidden") quietly();
		}, RECEIVE_RETRY_MS);
		return () => clearInterval(again);
	}, [waiting, health]);
	if (view === undefined) return null;
	if (wallet === undefined) return <Gone phone={phone} />;
	return (
		<Receive
			wallet={shownWallet(wallet, view, (id) => whoOf(agents, id), now)}
			state={wallet.state === "ready" ? (state ?? "checking") : wallet.state}
			onUnarchive={() => void attempt("unarchive the wallet", () => archiveWallet(wallet, false))}
			phone={phone}
			parent={toWallet(wallet)}
			copied={copied}
			acknowledged={acknowledged}
			onCopy={() => {
				if (given === undefined) return;
				// the record's address and the daemon's answer agree, or nothing is copied (H-261)
				if (!sameAddress(given, wallet.address)) {
					mismatched();
					return;
				}
				void copyText(given, "the address", "Select the address and copy it by hand.").then((done) => {
					if (done) setCopied(true);
				});
			}}
			onSaveKey={() => go({ name: "wallet", address: wallet.address, page: "key" })}
			onRetry={() => setTries((n) => n + 1)}
			{...(runsOnDevice
				? {}
				: {
						onAcknowledge: () =>
							void attempt("acknowledge the code", () => acknowledgeCode(wallet.address)).then((view) => {
								if (view !== undefined) setAcknowledged(true);
							}),
					})}
		/>
	);
}

/**
 * The wallet's address copied from its page, as Receive gives it: only the address the daemon answered once it marked it
 * disclosed and checked no code runs there (C17, C21, H-157); otherwise its Receive opens, which says why not.
 */
function copyAddress(address: string): void {
	void attempt("copy the address", () => openReceive(address)).then((answer) => {
		if (answer === undefined) return;
		if (answer.state !== "ready") {
			go({ name: "wallet", address, page: "receive" });
			return;
		}
		// the daemon's answer is the address the record holds, or nothing is copied (H-261)
		if (!sameAddress(answer.address, address)) {
			mismatched();
			return;
		}
		void copyText(answer.address, "the address", "Open Receive and copy it from there.").then((done) => {
			if (done) toast.success("Address copied");
		});
	});
}

/** Whether two whole addresses are one, whatever their letters' case: never a route's eight digits (H-261). */
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** An answer whose address is not the wallet's: said, and nothing copied (H-261). */
const mismatched = () =>
	toast.error("Couldn't give the address", {
		description: "banda answered an address that isn't this wallet's. Nothing was copied: don't pay into it.",
	});

/**
 * Puts `text` on the clipboard, and says in a toast when it could not (no clipboard here, or the browser refused):
 * every copy of an address goes through it, so none fails silently. Whether it was copied.
 */
async function copyText(text: string, what: string, instead: string): Promise<boolean> {
	try {
		if (navigator.clipboard === undefined) throw new Error("no clipboard");
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		toast.error(`Couldn't copy ${what}`, { description: instead });
		return false;
	}
}

function Gone({ phone }: { phone: boolean }) {
	return <NoWallet phone={phone} parent={toWallets} onWallets={() => go(WALLETS)} />;
}

/**
 * The wallet's key checked again, as its notice's Try again asks: once the wallet answers, the notice goes, a toast says
 * so, and the focus goes to the page's title, never to the page the notice's button leaves it on.
 */
async function recheck(address: string): Promise<void> {
	const view = await attempt("check the wallet's key", () => checkWallet(address));
	const after = view?.wallets.find((each) => each.address === address);
	if (view === undefined || after === undefined) return;
	const network = view.networks.find((each) => each.id === after.network);
	if (offlineOf(after, view.offline, network, view.keychain) !== undefined) return;
	toast.success(`${after.name}'s key answers again`);
	document.querySelector<HTMLElement>("h1[data-page-title]")?.focus();
}

/** The notices a wallet shows: why it cannot pay, with its fix where this screen can do it; its key not saved; archived. */
function Notices({ wallet, shown }: { wallet: WalletView; shown: ShownWallet }) {
	const reason = shown.offline;
	const fix = (): (() => void) | undefined => {
		const moving = behindOwner?.moveSigning;
		// a check reads the computer's keychain, which may prompt there: never asked from a paired device
		const checks = !runsOnDevice;
		switch (reason) {
			case "creating":
				// the keychain may answer now: banda settles what it left being made, and the wallet is ready or gone
				return checks ? () => void attempt("check the keychain", checkKeychain) : undefined;
			case "locked":
			case "denied":
			case "timeout":
			case "ambiguous":
			case "keychain":
				return checks ? () => void recheck(wallet.address) : undefined;
			case "no_keychain":
				return checks ? () => void attempt("check the keychain", checkKeychain) : undefined;
			case "key_missing":
				// only banda's desktop app takes a key to the keychain without the daemon seeing it (C20)
				return behindOwner?.restoreKey === undefined
					? undefined
					: () => go({ name: "wallet", address: wallet.address, page: "restore" });
			case "other_home":
				return moving === undefined
					? undefined
					: () =>
							void desktopAct({
								what: "move signing here",
								refused: "Signing wasn't moved here",
								run: moving,
								onDone: () => void attempt("check the wallet's key", () => checkWallet(wallet.address)),
							});
			case "coding_agent":
				// wallets come back once no coding agent is connected (H-065): Connections is where it is disconnected
				return () => go({ name: "connections" });
			case "chain":
				// a network's RPC is set in Settings, Wallets, on the computer alone
				return runsOnDevice ? undefined : () => go(WALLETS);
			default:
				return undefined;
		}
	};
	const action = fix();
	return (
		<>
			{reason === undefined ? null : (
				<OfflineNotice
					reason={reason}
					actionable={action !== undefined}
					onAction={action}
					unsaved={wallet.backup !== "saved"}
				/>
			)}
			{/* a key no longer in the keychain cannot be saved: the notice above says what is left to do. Only once it
			    holds more than a little (H-273): before, the row's quiet Not backed up mark and the Wallet tab say it */}
			{remindsToSave(wallet) && !unopenable(shown) ? (
				<WalletNotice
					icon={OFFLINE.key_missing.icon}
					title="Not backed up"
					body="Now that it holds money: if this computer is lost, so is what's in this wallet."
					// no key here to show while the reason above stands: its own act comes first (H-317)
					{...(runsOnDevice || !keySaves(wallet, reason)
						? {}
						: {
								action: "Save your key",
								onAction: () => go({ name: "wallet", address: wallet.address, page: "key" }),
							})}
				/>
			) : null}
			{wallet.state === "archived" ? (
				<ArchivedNotice onUnarchive={() => void attempt("unarchive the wallet", () => archiveWallet(wallet, false))} />
			) : null}
			{wallet.state === "removing" ? <RemovingNotice /> : null}
		</>
	);
}

/**
 * The money that came in to a wallet (UC-14 A3), read again whenever the daemon pushes the wallets after a read of the
 * chain changed them; a read that failed says why, with Try again. Earlier reads the older pages, kept below the
 * newest one, which each read again replaces.
 */
function Activity({ wallet, rpc, view, now }: { wallet: WalletView; rpc: RpcView; view: WalletsView; now: number }) {
	const [incoming, setIncoming] = useState<WalletIncoming | undefined>(undefined);
	const [older, setOlder] = useState<Pick<WalletIncoming, "rows" | "outside" | "more" | "dropped"> | undefined>(
		undefined,
	);
	const [loadingMore, setLoadingMore] = useState(false);
	const [failed, setFailed] = useState<unknown>(undefined);
	const [tries, setTries] = useState(0);
	// what comes in shows in seconds while the wallet's page stays open (UC-14)
	useLooking(wallet.address);
	// biome-ignore lint/correctness/useExhaustiveDependencies: another wallet starts from its newest page
	useEffect(() => {
		setOlder(undefined);
	}, [wallet.address]);
	/** The first read, and Try again, ask the daemon to read the chain now; a read after a push follows a read already. */
	const wakes = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: each push of the wallets, and each Try again, reads it again
	useEffect(() => {
		let live = true;
		const wake = wakes.current;
		wakes.current = false;
		void readIncoming(wallet.address, wake).then(
			(read) => {
				if (!live) return;
				setIncoming(read);
				setFailed(undefined);
			},
			(error: unknown) => {
				if (live) setFailed(error ?? new Error("no answer"));
			},
		);
		return () => {
			live = false;
		};
	}, [wallet.address, view, tries]);
	const retry = () => {
		wakes.current = true;
		setTries((n) => n + 1);
	};
	if (failed !== undefined && incoming === undefined)
		return <TransactionList rows={[]} failed={failureWords(failed)} onRetry={retry} />;
	if (incoming === undefined) return <TransactionList rows={[]} loading />;
	const seen = new Set(incoming.rows.map((row) => row.id));
	const rows = [...incoming.rows, ...(older?.rows ?? []).filter((row) => !seen.has(row.id))];
	const away = new Set((incoming.outside ?? []).map((row) => row.id));
	const outside = [...(incoming.outside ?? []), ...(older?.outside ?? []).filter((row) => !away.has(row.id))];
	const more = older === undefined ? incoming.more : older.more;
	const dropped = older === undefined ? incoming.dropped : older.dropped;
	const readMore = (before: string) => {
		setLoadingMore(true);
		void attempt("read earlier activity", () => readIncoming(wallet.address, false, before)).then((page) => {
			setLoadingMore(false);
			if (page === undefined) return;
			setOlder((kept) => ({
				rows: [...(kept?.rows ?? []), ...page.rows],
				outside: [...(kept?.outside ?? []), ...(page.outside ?? [])],
				...(page.more === undefined ? {} : { more: page.more }),
				...(page.dropped === undefined ? {} : { dropped: page.dropped }),
			}));
		});
	};
	return (
		<TransactionList
			{...(wallet.state === "creating" || wallet.state === "removing" ? { unmade: wallet.state } : {})}
			rows={activityRows(
				rows,
				incoming.reveals,
				now,
				view.networks.find((network) => network.id === wallet.network)?.explorer,
				more !== undefined,
				outside,
			)}
			{...(more === undefined ? {} : { onMore: () => readMore(more), loadingMore })}
			incomplete={incompleteOf(
				{ ...incoming, ...(dropped === undefined ? {} : { dropped }) },
				rpc.url?.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
				{ name: labelOf(view.networks, wallet.network), now },
			)}
			{...(failed === undefined ? {} : { failed: failureWords(failed), onRetry: retry })}
		/>
	);
}

/** One wallet, opened: its balance and Receive, its notices, what came in, its agents, and its own settings. */
function WalletScreen({
	address,
	tab,
	agents,
	everyone,
	phone,
}: {
	address: string;
	tab?: WalletTab | undefined;
	/** The band's agents, which a wallet is switched on for. */
	agents: readonly ChatAgent[];
	/** Every agent, archived ones too, which name a wallet's agents. */
	everyone: readonly ChatAgent[];
	phone: boolean;
}) {
	const view = useWallets();
	const now = useNow(WALLET_TICK);
	const [removing, setRemoving] = useState(false);
	const wallet = view?.wallets.find((each) => same(each.address, address));
	const reminding = useMemo(() => (wallet === undefined ? undefined : [wallet]), [wallet]);
	useSaveReminder(reminding, view?.networks);
	if (view === undefined) return null;
	if (wallet === undefined) return <Gone phone={phone} />;
	return (
		<OneWallet
			view={view}
			now={now}
			wallet={wallet}
			tab={tab ?? "activity"}
			agents={agents}
			everyone={everyone}
			phone={phone}
			removing={removing}
			onRemoving={setRemoving}
		/>
	);
}

/** Whether a wallet's address is the one a page was given: the whole address, whatever its letters' case. */
const same = (address: string, given: string) => routesTo(address, given);

/**
 * A wallet's page as its link names it: the link's route (`walletRoute`), or an address in any case, is matched to the
 * wallet's address once the wallets are read, and each page is given the whole address; a route two wallets answer
 * asks which, kept on this page alone; a route no wallet answers is given as it came, and the page says the wallet is
 * gone.
 */
export function WalletRoute({
	route,
	page,
	tab,
	agents,
	everyone,
	phone,
}: {
	route: string;
	page?: Subpage | undefined;
	tab?: WalletTab | undefined;
	agents: readonly ChatAgent[];
	everyone: readonly ChatAgent[];
	phone: boolean;
}) {
	const view = useWallets();
	const [chosen, setChosen] = useState<{ readonly route: string; readonly address: string } | undefined>(undefined);
	if (view === undefined) return null;
	const named = routedTo(
		view.wallets.map((each) => each.address),
		route,
	);
	const picked = chosen?.route === route && named.includes(chosen.address) ? chosen.address : undefined;
	if (named.length > 1 && picked === undefined) {
		const shown = view.wallets
			.filter((each) => named.includes(each.address))
			.map((each) => ({
				name: each.name,
				address: each.address,
				network: labelOf(view.networks, each.network),
				testnet: view.networks.find((network) => network.id === each.network)?.testnet === true,
			}));
		return (
			<WhichWallet
				wallets={shown}
				phone={phone}
				parent={toWallets}
				onChoose={(address) => setChosen({ route, address })}
			/>
		);
	}
	const address = picked ?? named[0] ?? route;
	if (page === "key") return <WalletKey key={address} address={address} agents={everyone} phone={phone} />;
	if (page === "receive") return <WalletReceive key={address} address={address} agents={everyone} phone={phone} />;
	if (page === "restore") return <WalletRestore key={address} address={address} agents={everyone} phone={phone} />;
	return <WalletScreen key={address} address={address} tab={tab} agents={agents} everyone={everyone} phone={phone} />;
}

function OneWallet({
	view,
	now,
	wallet,
	tab,
	agents,
	everyone,
	phone,
	removing,
	onRemoving,
}: {
	view: WalletsView;
	now: number;
	wallet: WalletView;
	tab: WalletTab;
	agents: readonly ChatAgent[];
	everyone: readonly ChatAgent[];
	phone: boolean;
	removing: boolean;
	onRemoving: (removing: boolean) => void;
}) {
	const shown = shownWallet(wallet, view, (id) => whoOf(everyone, id), now);
	const rpc = rpcRows(view.networks, now).find((each) => each.id === wallet.network) ?? {
		network: shown.network,
		byDefault: true,
		logs: true,
	};
	const archived = wallet.state === "archived";
	// archiving puts Unarchive where Archive was, and unarchiving the other way: the control that had the focus goes
	// with the change, and the focus goes to the page's title, never to the page (the confirm's own close, when it
	// ends after the change, does the same: Confirm)
	const wasArchived = useRef(archived);
	useLayoutEffect(() => {
		if (wasArchived.current === archived) return;
		wasArchived.current = archived;
		const active = document.activeElement;
		if (active === null || active === document.body)
			document.querySelector<HTMLElement>("h1[data-page-title]")?.focus();
	}, [archived]);
	const [blocked, setBlocked] = useState<string | undefined>(undefined);
	/** Why removal is refused before it is asked: an address given out over a key never saved (C17). */
	const unremovable = wallet.disclosed && wallet.backup !== "saved" ? sentence(UNSAVED_DISCLOSED) : undefined;
	const remove = () => {
		onRemoving(true);
		void removeWallet(wallet)
			.then(
				() => {
					toast.success(`${wallet.name} is removed, and its key with it`);
					go(WALLETS);
				},
				(error: unknown) => {
					// a wallet that holds money or a payment (C17) is refused until that changes: the same act cannot help
					if (error instanceof Refused && error.status === 409) setBlocked(sentence(error.message));
					else sayFailed("remove the wallet", error, remove);
				},
			)
			.finally(() => onRemoving(false));
	};
	return (
		<WalletPage
			wallet={shown}
			phone={phone}
			tab={tab}
			tabs={OFFERED_TABS}
			parent={toWallets}
			sends={false}
			canReceive={wallet.state === "ready" && !unopenable(shown)}
			onCopyAddress={() => copyAddress(wallet.address)}
			onTab={(next) => location.replace(hrefOf({ name: "wallet", address: wallet.address, tab: next }))}
			onReceive={() => go({ name: "wallet", address: wallet.address, page: "receive" })}
			notices={<Notices wallet={wallet} shown={shown} />}
			activity={<Activity wallet={wallet} rpc={rpc} view={view} now={now} />}
			agents={
				<WalletAgents
					agents={agents.map((agent) => ({ agent: whoOf(agents, agent.id), on: wallet.agents.includes(agent.id) }))}
					disabled={unswitchable(wallet)}
					onSwitch={(agent, on) =>
						void attempt(on ? "let the agent read the wallet" : "switch the wallet off", () =>
							switchWalletAgent(wallet.address, agent, on),
						)
					}
				/>
			}
			options={
				<WalletOptions
					wallet={shown}
					host={!runsOnDevice}
					saves={keySaves(wallet, view.offline)}
					shows={behindOwner?.revealKey !== undefined && keySaves(wallet, view.offline)}
					laterKey={laterKey}
					rpc={rpc}
					onSaveKey={() => go({ name: "wallet", address: wallet.address, page: "key" })}
					onShowKey={() => go({ name: "wallet", address: wallet.address, page: "key" })}
					onArchive={() => void attempt("unarchive the wallet", () => archiveWallet(wallet, false))}
					{...(archived
						? {}
						: {
								archive: (
									<Confirm
										{...archiveWords(wallet.name)}
										action="Archive"
										onConfirm={() => void attempt("archive the wallet", () => archiveWallet(wallet, true))}
									>
										<Button variant="outline" size="sm">
											Archive
										</Button>
									</Confirm>
								),
							})}
					remove={
						<>
							{unremovable === undefined ? (
								<Confirm {...removeWords(wallet.name, wallet.backup)} action="Remove" onConfirm={remove}>
									<Button variant="destructive" size="sm" disabled={runsOnDevice || removing}>
										Remove
									</Button>
								</Confirm>
							) : (
								// the daemon refuses it whatever the owner confirms (C17): why, never a loss to agree to
								<Button
									variant="destructive"
									size="sm"
									disabled={runsOnDevice || removing}
									onClick={() => setBlocked(unremovable)}
								>
									Remove
								</Button>
							)}
							<RemoveRefused wallet={wallet.name} reason={blocked} onClose={() => setBlocked(undefined)} />
						</>
					}
				/>
			}
		/>
	);
}

/** The daemon's reason as a sentence: its first letter capital, a full stop at its end. */
const sentence = (words: string) => {
	const trimmed = words.trim();
	const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/** The wallets in an agent's panel (Access): each ready one, switched on or off for it, or a way to give it one. */
export function AccessWallets({
	agent,
	everyone,
}: {
	agent: { readonly id: string; readonly name: string };
	/** Every agent, archived ones too, which name the agents a wallet serves. */
	everyone: readonly ChatAgent[];
}) {
	const view = useWallets();
	const now = useNow(WALLET_TICK);
	if (view === undefined) return null;
	const wallets = view.wallets
		.filter((wallet) => wallet.state === "ready" || wallet.agents.includes(agent.id))
		.map((wallet) => ({
			wallet: shownWallet(wallet, view, (id) => whoOf(everyone, id), now),
			on: wallet.agents.includes(agent.id),
			// the same rule as the wallet's own Agents tab: only its state bars a switch, never why it is offline (UC-05)
			disabled: unswitchable(wallet),
		}));
	return (
		<AgentWallets
			agent={agent.name}
			wallets={wallets}
			onSwitch={(address, on) =>
				void attempt(on ? `let ${agent.name} read the wallet` : "switch the wallet off", () =>
					switchWalletAgent(address, agent.id, on),
				)
			}
			// a paired device makes one too: its key is then seen on the computer (H-276)
			onCreate={() => go({ name: "wallet", agent: agent.id })}
		/>
	);
}
