/**
 * Wallets, as the owner sees them (docs/wallets.md). Settings → Wallets lists every wallet
 * with its balance, its agents and, when it cannot pay, its one offline reason; a wallet opens to its balance, Send and
 * Receive, and its tabs: Activity (every payment in its state, and what came in), Recipients (each one's Always, Ask or
 * Deny), Agents (who may read it) and Wallet (its key, its network, archive and remove). Making one, saving its
 * key, sending, receiving and getting it back online are each a page of their own. Every figure is a dated reading,
 * never a fact: a balance the RPC did not answer is unknown, never zero.
 */
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	ArrowDownLeftIcon,
	ArrowLeftRightIcon,
	ArrowUpRightIcon,
	BugIcon,
	CheckIcon,
	ChevronRightIcon,
	CircleDashedIcon,
	CircleSlashIcon,
	ClockIcon,
	CopyIcon,
	ExternalLinkIcon,
	FingerprintIcon,
	GlobeIcon,
	HourglassIcon,
	KeyRoundIcon,
	KeySquareIcon,
	LockIcon,
	type LucideIcon,
	MonitorIcon,
	PlusIcon,
	ServerIcon,
	ShieldAlertIcon,
	TerminalIcon,
	Trash2Icon,
	TriangleAlertIcon,
	UserRoundIcon,
	WalletIcon,
	XIcon,
} from "lucide-react";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { NAME_MAX, shortAddress } from "../../../src/wallet/label.ts";
import { NOT_A_KEY, sharedBy } from "../app/wallets.ts";
import type { WalletTab } from "../app/where.ts";
import { QrCode } from "../components/QrCode.tsx";
import type { WalletView } from "../lib/api.ts";
import type { LaterKey } from "../lib/desktop.ts";
import { Confirm } from "./Confirm.tsx";
import { Face } from "./Face.tsx";
import type { Who } from "./Row.tsx";
import { Block, RowOf, Rows, SettingsPage } from "./Settings.tsx";

// ── What a wallet is, to the screen ─────────────────────────────────────────────────────────────────────────────────

/** A network as the owner reads it: its label, "Base", "Base Sepolia". */
export type Network = string;
export type Token = "USDC" | "ETH";

/**
 * Why a wallet cannot pay: one reason from one list (UC-04 E2, H-317), the `signing` machine's states, the signer's codes
 * that say more than `locked` does (a debugger on, a prompt refused, a keychain that does not answer, two items, none at
 * all, any other failure), and C17's code.
 */
export type OfflineReason =
	| "creating"
	| "locked"
	| "denied"
	| "timeout"
	| "ambiguous"
	| "no_keychain"
	| "keychain"
	| "debugging"
	| "key_missing"
	| "wrong_key"
	| "other_home"
	| "host_mode"
	| "coding_agent"
	| "identity"
	| "chain"
	| "code";

/** Whether the owner saved the key: confirmed by pasting it back, skipped, or not asked yet (the `wallet` machine). */
export type Backup = "saved" | "skipped" | "unsaved";

export type ShownWallet = {
	readonly name: string;
	readonly network: Network;
	/** A test network's money is worth nothing: marked wherever the wallet is named (H-040). */
	readonly testnet?: boolean | undefined;
	/** EIP-55, in full. */
	readonly address: string;
	/** As read; null when the RPC did not answer, which is never shown as zero; absent on a network with no USDC. */
	readonly usdc?: string | null | undefined;
	readonly eth: string | null;
	/** The owner's currency, an estimate, dated by `read`. */
	readonly fiat?: string | undefined;
	/** When and where the balance was read: "1 min ago, block 23,145,880". */
	readonly read: string;
	/** The last reading that did answer, when this one did not: its figures and when, "0.5 ETH, 2 min ago, at block 7". */
	readonly last?: string | undefined;
	/** The network has not answered since this time ("14:02"): the balance is unknown, whatever was read before (H-208). */
	readonly unreachable?: string | undefined;
	/** No balance read yet, and the network's RPC is being asked: not unknown, only not here yet. */
	readonly reading?: boolean | undefined;
	/** Not made yet, or being removed: nothing is read for it, so its balance is neither unknown nor being read. */
	readonly unmade?: "creating" | "removing" | undefined;
	readonly backup: Backup;
	readonly agents: readonly Who[];
	readonly offline?: OfflineReason | undefined;
	readonly archived?: boolean | undefined;
};

/** Why nothing is read for a wallet not made yet, or being removed: its balance line and its activity say it. */
export const UNMADE_WORDS = {
	creating: "This wallet isn't made yet: banda reads nothing for it until it is.",
	removing: "This wallet is being removed: banda reads nothing for it now.",
} as const;

/** An address as it is checked by eye: in groups of four, every character shown. */
export const grouped = (address: string) => `0x ${(address.slice(2).match(/.{1,4}/g) ?? []).join(" ")}`;

/** A key's groups as `KeyBox` draws them: `0x`, then its digits four by four. */
const keyGroups = (key: string) => ["0x", ...(key.slice(2).match(/.{1,4}/g) ?? [])];

/** TA-1 said where wallets are made and listed: the keychain answers any program the owner runs (H-016). */
export const ANY_PROGRAM =
	"Any program you run on this computer can use these wallets as banda does, so run only programs you trust. If your keychain asks whether another app may use a banda wallet, deny it.";

/** TA-1 said where a coding agent is turned on, once the home has a wallet: it runs as the owner (H-016). */
export const CODING_AGENT_WALLETS =
	"It runs as you, so it can use your wallets as any program you run can. banda doesn't hand it a wallet; turn it on only if you trust it with them.";

/** What an agent reads of a wallet goes to its model provider, said where a wallet is switched on for one (H-070). */
export const PROVIDER_SEES =
	"What an agent reads of a wallet, its address, network and balance, goes to its model provider like anything else it reads.";

/** The one list of offline reasons: what happened, what it means, and the one thing to do about it. */
export const OFFLINE: Record<
	OfflineReason,
	{
		icon: LucideIcon;
		title: string;
		body: string;
		action?: string;
		/** Where its fix is made, said where this screen cannot make it. */
		elsewhere?: string;
		/**
		 * What it says instead for a wallet whose key was never saved: no copy can be "the one you saved", and nothing
		 * sent to its address could be spent (H-021, H-261).
		 */
		unsaved?: { body: string; elsewhere?: string };
	}
> = {
	creating: {
		icon: HourglassIcon,
		title: "Waiting for your keychain",
		body: "The wallet is made as soon as your keychain answers. Unlock it, or answer its prompt.",
		action: "Try again",
	},
	locked: {
		icon: LockIcon,
		title: "Keychain locked",
		body: "Unlock your keychain so banda can check this wallet's key.",
		action: "Try again",
	},
	denied: {
		icon: LockIcon,
		title: "Needs keychain access again",
		body: "Your keychain asked whether banda may use this wallet's key, as it does after banda updates, and the answer was no. Try again and choose Always allow.",
		action: "Try again",
	},
	timeout: {
		icon: HourglassIcon,
		title: "Your keychain didn't answer",
		body: "Your keychain took too long to answer, perhaps behind a prompt you haven't seen. Answer it, then try again.",
		action: "Try again",
	},
	ambiguous: {
		icon: KeySquareIcon,
		title: "Two keys for this wallet",
		body: "Your keychain holds more than one item for this wallet, so banda won't guess which key to sign with. Delete the extra item with your keychain's own app, keeping the one under this wallet's address, then try again.",
		action: "Try again",
	},
	no_keychain: {
		icon: LockIcon,
		title: "No keychain",
		body: "This computer has no keychain banda can use. Run banda in a desktop session with a keychain, then try again.",
		action: "Try again",
	},
	keychain: {
		icon: TriangleAlertIcon,
		title: "Couldn't use your keychain",
		body: "banda couldn't read this wallet's key from your keychain. Try again; if it keeps failing, restart banda.",
		action: "Try again",
	},
	debugging: {
		icon: BugIcon,
		title: "Debugging is on",
		body: "banda runs with a debugger or heap-dump flag (such as --inspect), which could read a key from its memory. Wallets stay offline until banda runs without it.",
	},
	key_missing: {
		icon: KeyRoundIcon,
		title: "Key missing",
		body: "Your keychain no longer holds this wallet's key. The copy you saved brings it back.",
		action: "Restore key",
		elsewhere:
			"Restore it in banda's desktop app, on the computer banda runs on, if it's a Mac with Touch ID. Meanwhile your copy opens the wallet in any wallet app, such as MetaMask.",
		unsaved: {
			body: "Your keychain no longer holds this wallet's key, and no copy of it was saved, so nothing sent to its address can be spent. Don't send anything there. If you kept a copy without checking it, restoring it brings the wallet back.",
			elsewhere: "Restore it in banda's desktop app, on the computer banda runs on, if it's a Mac with Touch ID.",
		},
	},
	wrong_key: {
		icon: ShieldAlertIcon,
		title: "Wrong key",
		body: "The key in your keychain doesn't open this wallet's address, so banda won't sign with it, nor write over it.",
		elsewhere:
			"Meanwhile the copy you saved opens the wallet in any wallet app, such as MetaMask. Once you remove that item with your keychain's own app, banda's desktop app on a Mac with Touch ID restores the key from your copy.",
		unsaved: {
			body: "The key in your keychain doesn't open this wallet's address, and no copy of its key was saved, so nothing sent to its address can be spent. Don't send anything there; banda won't sign with that key, nor write over it.",
			elsewhere:
				"If you kept a copy without checking it, remove that item with your keychain's own app, and banda's desktop app on a Mac with Touch ID restores the key from your copy.",
		},
	},
	other_home: {
		icon: ServerIcon,
		title: "Another home signs for this wallet",
		body: "This home is a copy (a backup, a fork or a new computer): it shows the wallet and never pays from it.",
		action: "Move signing here",
		elsewhere: "Move signing here from banda's desktop app on this computer.",
	},
	host_mode: {
		icon: TerminalIcon,
		title: "Commands on this computer can read wallet keys",
		body: "Agents run commands on this computer as you, without a box. Wallets stay offline until banda runs with a box again.",
	},
	coding_agent: {
		icon: TerminalIcon,
		title: "A coding agent can read wallet keys",
		body: "A coding agent is connected on this computer, and a command it runs could read a wallet's key. Wallets stay offline while any coding agent is connected; disconnect it to bring them back.",
		action: "Disconnect it",
	},
	identity: {
		icon: ShieldAlertIcon,
		title: "This home's identity is missing",
		body: "banda names every wallet key in your keychain after this home's identity, kept in its auth/device-id file, and that file is gone or replaced. Put back the one this home had, then start banda again: until then the wallets are offline, and banda changes nothing of them.",
	},
	chain: {
		icon: ServerIcon,
		title: "This network's RPC serves another chain",
		body: "The RPC set for this wallet's network answers for a different chain, so banda reads nothing through it: no balance, no money coming in, and no address handed out. Set an RPC of this network.",
		action: "Set the RPC",
		elsewhere: "Set it in Settings, Wallets, on the computer banda runs on.",
	},
	code: {
		icon: TriangleAlertIcon,
		title: "This address now runs code",
		body: "Someone used this wallet's key outside banda to attach code to its address. Agents can't use it; don't send money to it until you know why.",
	},
};

// ── Small parts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A wallet's mark: the same small tile wherever a wallet is named. */
export function WalletMark({ size = "row" }: { size?: "row" | "hero" }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center rounded-field bg-paper-3 text-ink-2",
				size === "hero" ? "size-10 [&>svg]:size-5" : "size-8 [&>svg]:size-4",
			)}
		>
			<WalletIcon />
		</span>
	);
}

/** The mark a wallet on a test network carries on every row, card and caption, so its money is never taken for real. */
function TestnetMark() {
	return (
		<span className="inline-flex shrink-0 items-center rounded-full border border-line px-1.5 text-meta leading-4 text-ink-2">
			Testnet
		</span>
	);
}

/**
 * An address in a row: its ends, the network, and a copy button, which copies it itself, or (a function) asks first
 * whether the address may leave banda, as Receive does.
 */
export function Address({
	address,
	network,
	testnet = false,
	copy,
}: {
	address: string;
	network?: Network;
	testnet?: boolean;
	/** Copies the whole address through Receive, which marks it as left banda first (C17, C21); none draws no button. */
	copy?: (() => void) | undefined;
}) {
	return (
		<span className="inline-flex items-center gap-1">
			<span className="font-code">{shortAddress(address)}</span>
			{network === undefined ? null : <span>on {network}</span>}
			{network !== undefined && testnet ? <TestnetMark /> : null}
			{copy === undefined ? null : (
				<Button variant="ghost" size="icon-xs" aria-label="Copy the address" className="text-ink-2" onClick={copy}>
					<CopyIcon />
				</Button>
			)}
		</span>
	);
}

/** Whether the balance was read: neither figure is unknown. */
const known = (wallet: ShownWallet) => wallet.usdc !== null && wallet.eth !== null;

/** A balance in a row: USDC first, ETH beneath (ETH alone on a network with no USDC); unknown when the RPC did not answer. */
function Balance({ wallet }: { wallet: ShownWallet }) {
	if (!known(wallet))
		return (
			// narrow and wrapping: the since-when line never takes the row's width from the wallet's name
			<span className="flex max-w-28 flex-col items-end text-right text-meta text-ink-2">
				<span>
					{wallet.unmade === "creating"
						? "Not made yet"
						: wallet.unmade === "removing"
							? "Being removed"
							: wallet.reading === true
								? "Reading the balance…"
								: "Balance unknown"}
				</span>
				{wallet.unreachable === undefined ? null : (
					<span data-unreachable="">
						{wallet.network} not answering since {wallet.unreachable}
					</span>
				)}
			</span>
		);
	return (
		<span className="flex flex-col items-end tabular-nums">
			{wallet.usdc === undefined ? null : <span className="text-ui text-ink">{wallet.usdc} USDC</span>}
			<span className={wallet.usdc === undefined ? "text-ui text-ink" : "text-meta text-ink-2"}>{wallet.eth} ETH</span>
			{/* a figure is derived and dated (C22): the block it was read at, and when, never a bare figure as if it were now */}
			<span data-read="" className="max-w-28 text-right text-meta text-ink-2 [overflow-wrap:anywhere]">
				Read {wallet.read}
			</span>
		</span>
	);
}

/** The agents a wallet is on for, as their faces, overlapping. */
export function Faces({ agents }: { agents: readonly Who[] }) {
	if (agents.length === 0) return null;
	return (
		<span className="flex -space-x-1.5">
			{agents.map((agent) => (
				<Face key={agent.name} face={agent.face} name={agent.name} size="mention" className="ring-2 ring-paper" />
			))}
		</span>
	);
}

/** A notice on a wallet: an offline reason, a missing backup, an archived wallet. One per kind, the fix in its button. */
export function WalletNotice({
	icon: Icon,
	title,
	body,
	action,
	tone = "quiet",
	onAction,
}: {
	icon: LucideIcon;
	title: string;
	body: string;
	action?: string | undefined;
	tone?: "quiet" | "danger";
	onAction?: () => void;
}) {
	return (
		<Alert variant={tone === "danger" ? "destructive" : "default"}>
			<Icon />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-2">
				<span>{body}</span>
				{action === undefined ? null : (
					<Button variant="outline" size="sm" onClick={onAction}>
						{action}
					</Button>
				)}
			</AlertDescription>
		</Alert>
	);
}

/** An archived wallet's notice; Unarchive shows only with `onUnarchive`, or in a specimen, which has none to run. */
export function ArchivedNotice({ onUnarchive }: { onUnarchive?: () => void }) {
	return (
		<WalletNotice
			icon={ArchiveIcon}
			title="Archived"
			body="Agents can't use it, and it neither sends nor gives out its address until you unarchive it. Money sent to it still arrives."
			action="Unarchive"
			{...(onUnarchive === undefined ? {} : { onAction: onUnarchive })}
		/>
	);
}

/** A removal waiting on the keychain (wallet: removing): money that arrives meanwhile stops it, and archives the wallet. */
export function RemovingNotice() {
	return (
		<WalletNotice
			icon={Trash2Icon}
			title="Being removed"
			body="banda deletes its key from your keychain once the keychain answers, and checks nothing reached it first."
		/>
	);
}

/** An offline reason's notice; its fix shows only with `onAction`, or in a specimen, which has none to run. */
export function OfflineNotice({
	reason,
	onAction,
	actionable = true,
	unsaved = false,
}: {
	reason: OfflineReason;
	onAction?: (() => void) | undefined;
	/** False where its fix cannot be done here: a move of signing outside the desktop app. */
	actionable?: boolean;
	/** The wallet's key was never saved: a reason that speaks of the saved copy says what holds without one. */
	unsaved?: boolean;
}) {
	const base = OFFLINE[reason];
	const words = unsaved && base.unsaved !== undefined ? { ...base, ...base.unsaved } : base;
	return (
		<WalletNotice
			icon={words.icon}
			title={words.title}
			body={!actionable && words.elsewhere !== undefined ? `${words.body} ${words.elsewhere}` : words.body}
			action={actionable ? words.action : undefined}
			tone={reason === "code" || reason === "wrong_key" || reason === "ambiguous" ? "danger" : "quiet"}
			{...(onAction === undefined ? {} : { onAction })}
		/>
	);
}

/** A segmented control, as Settings' Appearance draws one. */
export function Segmented<T extends string>({
	label,
	options,
	value,
	disabled = false,
	onChange,
}: {
	label: string;
	options: readonly { value: T; label: string }[];
	value: T;
	disabled?: boolean;
	onChange?: (value: T) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className={cn("flex shrink-0 self-start rounded-field bg-paper-3 p-0.5", disabled && "opacity-40")}
		>
			{options.map((one) => (
				// biome-ignore lint/a11y/useSemanticElements: a segment of a segmented control
				<button
					key={one.value}
					type="button"
					role="radio"
					aria-checked={value === one.value}
					disabled={disabled}
					onClick={() => onChange?.(one.value)}
					className={cn(
						"rounded-[6px] px-2.5 py-1 text-ui text-ink-2",
						value === one.value && "bg-paper font-medium text-ink shadow-[0_0_0_1px_var(--line-soft)]",
					)}
				>
					{one.label}
				</button>
			))}
		</div>
	);
}

// ── Settings → Wallets ──────────────────────────────────────────────────────────────────────────────────────────────

export type RpcView = {
	/** The network's id, which a change is made by; its label where absent (a specimen). */
	readonly id?: string | undefined;
	readonly network: Network;
	/** Masked: the RPC's host and path, never a key it carries (H-195); absent when the network has none. */
	readonly url?: string | undefined;
	/** banda's default, a public endpoint, said as such; absent from the home's configuration until the owner changes it. */
	readonly byDefault: boolean;
	/** Whether it serves the log queries the incoming list is built from (banda's default does; mainnet.base.org does not). */
	readonly logs: boolean;
	/** Why it cannot be used as set, in banda's fixed words. */
	readonly problem?: string | undefined;
	/** banda ships a default RPC for it, which "Use banda's default" goes back to; true unless said. */
	readonly shipped?: boolean | undefined;
	/** It has not answered since this time ("14:02"). */
	readonly unreachable?: string | undefined;
	/** It answers, but for another chain than the network's (H-187): nothing it serves is read as the network's. */
	readonly otherChain?: boolean | undefined;
};

/** The RPC being changed: which network's, and why the last try was refused. */
export type RpcEditing = { readonly network: string; readonly error?: string | undefined; readonly busy?: boolean };

/**
 * A network's RPC being changed: a new URL, typed fresh (the one set is never shown back, only its masked form), or
 * banda's default again.
 */
function RpcForm({
	rpc,
	editing,
	onSave,
	onDefault,
	onCancel,
}: {
	rpc: RpcView;
	editing: RpcEditing;
	onSave?: ((url: string) => void) | undefined;
	onDefault?: (() => void) | undefined;
	onCancel?: (() => void) | undefined;
}) {
	const [url, setUrl] = useState("");
	// the form takes the place of the Change button pressed: the focus goes to its field, not to the page. Only on a live
	// page: a specimen takes no focus (it would scroll the specimen to it as the section mounts)
	const field = useRef<HTMLInputElement>(null);
	const live = onSave !== undefined;
	useEffect(() => {
		if (live) field.current?.focus();
	}, [live]);
	return (
		<form
			className="flex flex-col gap-2 px-3.5 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (url.trim() !== "") onSave?.(url.trim());
			}}
		>
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
			<label className="flex flex-col gap-1.5">
				<span className="text-ui font-medium text-ink">{rpc.network}'s RPC</span>
				<Input
					ref={field}
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					placeholder="https://…"
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					aria-invalid={editing.error !== undefined}
					disabled={editing.busy === true}
					className="font-code"
				/>
				<span className="text-meta text-ink-2">
					Now <span className="font-code">{rpc.url ?? "none"}</span>. A key in the URL stays on this computer and is
					never shown.
				</span>
				{editing.error === undefined ? null : <span className="text-meta text-danger">{editing.error}</span>}
			</label>
			<span className="flex flex-wrap gap-2">
				<Button type="submit" size="sm" disabled={editing.busy === true || url.trim() === ""}>
					{editing.busy === true ? <Spinner className="size-3.5" /> : null}
					Save
				</Button>
				{rpc.byDefault || rpc.shipped === false ? null : (
					<Button type="button" variant="outline" size="sm" disabled={editing.busy === true} onClick={onDefault}>
						Use banda's default
					</Button>
				)}
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</span>
		</form>
	);
}

/** A part of a line of parts, its separator drawn before it in a 0.75rem margin. */
const SEPARATED =
	"inline-flex shrink-0 items-center whitespace-nowrap before:w-3 before:shrink-0 before:text-center before:font-sans before:content-['·']";

/**
 * Whether no key opens the wallet any more and none was saved: its address is given out nowhere, since nothing sent
 * there could be spent (H-021, H-261). The daemon's Receive says so too; this keeps the button from offering it.
 */
export const unopenable = (wallet: Pick<ShownWallet, "backup" | "offline">): boolean =>
	wallet.backup !== "saved" && (wallet.offline === "key_missing" || wallet.offline === "wrong_key");

/**
 * The one line that says why a wallet is offline, from the one list of reasons (H-317), wherever a wallet is listed:
 * never cut, beside a balance that explains itself too; on a phone it wraps beneath its icon.
 */
function OfflineLine({ wallet }: { wallet: Pick<ShownWallet, "offline"> }) {
	const reason = wallet.offline === undefined ? undefined : OFFLINE[wallet.offline];
	if (reason === undefined) return null;
	return (
		<span
			data-reason=""
			className={cn(
				"flex min-w-0 items-start gap-1 text-meta",
				wallet.offline === "code" || wallet.offline === "wrong_key" ? "text-danger" : "text-ink-2",
			)}
		>
			<reason.icon className="mt-0.5 size-3 shrink-0" />
			<span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{reason.title}</span>
		</span>
	);
}

/** One wallet in the list: its mark, name, network and address; its balance; its agents and its one mark. */
function WalletRow({ wallet, onOpen }: { wallet: ShownWallet; onOpen?: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex min-h-16 w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-paper-2"
		>
			<WalletMark />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-ui font-medium text-ink">{wallet.name}</span>
				{/* the network says where money must be sent, the short address tells same-named wallets apart: neither is
				    cut, and the address goes beneath where both do not fit */}
				{/* each part carries its separator before it, and a part that starts a line has it in the margin the
				    row clips: no line starts with one. The network is never cut: narrower than its name and mark (a
				    phone, a balance that says why it is unknown), it wraps inside the row, its mark kept whole */}
				<span data-meta="" className="flex min-w-0 overflow-hidden text-meta text-ink-2">
					<span className="-ml-3 flex min-w-0 flex-wrap items-center">
						<span className={cn(SEPARATED, "min-w-0 max-w-full shrink whitespace-normal")}>
							<span data-network="" className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
								<span className="min-w-0 [overflow-wrap:anywhere]">{wallet.network}</span>
								{wallet.testnet === true ? <TestnetMark /> : null}
							</span>
						</span>
						<span data-short="" className={cn(SEPARATED, "font-code")}>
							{shortAddress(wallet.address)}
						</span>
					</span>
				</span>
				<OfflineLine wallet={wallet} />
				{/* the quiet sign that no copy of the key is saved stays beside any reason it can't pay (H-273, H-039) */}
				{wallet.backup === "saved" ? null : (
					<span data-unsaved="" className="flex items-center gap-1 text-meta text-ink-2">
						<KeyRoundIcon className="size-3 shrink-0" />
						Not backed up
					</span>
				)}
			</span>
			<span className="flex shrink-0 flex-col items-end gap-1">
				<Balance wallet={wallet} />
				<Faces agents={wallet.agents} />
			</span>
			<ChevronRightIcon className="size-4 shrink-0 text-ink-2" />
		</button>
	);
}

/**
 * Settings → Wallets: every wallet, archived ones folded away, making one, and the RPC each network reads through. With
 * none yet, what a wallet is and how to start; with no keychain to keep a key in, why none can be made here.
 */
export function WalletsSettings({
	wallets,
	archived = [],
	rpc,
	keychain = "ready",
	hostMode = false,
	onCreate,
	onCheckKeychain,
	onOpen,
	editing,
	rpcHere = true,
	onChangeRpc,
	onSaveRpc,
	onDefaultRpc,
	onCancelRpc,
	orphans = [],
	onFindOrphans,
	orphanSearch,
	onExportOrphan,
	onDeleteOrphan,
}: {
	wallets: readonly ShownWallet[];
	archived?: readonly ShownWallet[];
	/**
	 * Addresses the keychain holds a key for that no wallet names (H-045): listed, never adopted, and deleted only when
	 * the owner confirms it.
	 */
	orphans?: readonly string[];
	/**
	 * Look for keys without a wallet, on the computer only: a listing loads every item of the keychain's service and may
	 * prompt once per item, so it runs only when the owner asks (H-009, H-037); undefined elsewhere.
	 */
	onFindOrphans?: (() => void) | undefined;
	/** Where the owner's look for keys without a wallet stands: running, none found, or a keychain that can't list. */
	orphanSearch?: "finding" | "none" | "unlisted" | undefined;
	/** Show a key without a wallet, in banda's desktop app after the computer asks it's the owner; undefined elsewhere. */
	onExportOrphan?: ((address: string) => void) | undefined;
	/** Delete a key without a wallet, once confirmed, in banda's desktop app; undefined elsewhere. */
	onDeleteOrphan?: ((address: string) => void) | undefined;
	rpc: readonly RpcView[];
	/** `none`: no keychain this process can reach (headless Linux, UC-20). */
	keychain?: "ready" | "none";
	hostMode?: boolean;
	onCreate?: () => void;
	/** Check again whether the keychain answers, where none was found. */
	onCheckKeychain?: (() => void) | undefined;
	onOpen?: (address: string) => void;
	/** The RPC being changed, if one is. */
	editing?: RpcEditing | undefined;
	/** False on a paired device: an RPC is set only on the computer banda runs on. */
	rpcHere?: boolean;
	/** Change the RPC of the network with this id. */
	onChangeRpc?: ((network: string) => void) | undefined;
	onSaveRpc?: (network: string, url: string) => void;
	onDefaultRpc?: (network: string) => void;
	onCancelRpc?: () => void;
}) {
	// the network whose RPC form was opened: its Change button takes the focus back when the form closes
	const changed = useRef<string | undefined>(undefined);
	const create = (
		<Button variant="outline" size="sm" disabled={keychain === "none"} onClick={onCreate}>
			<PlusIcon />
			New wallet
		</Button>
	);
	return (
		<>
			{hostMode ? <OfflineNotice reason="host_mode" /> : null}
			<Block
				title="Wallets"
				note="Wallets your agents may read: an agent a wallet is on for sees its address and balance."
			>
				{keychain === "none" ? (
					<WalletNotice
						icon={KeyRoundIcon}
						title="This computer has no keychain banda can use"
						body="banda keeps each wallet's key in your system's keychain and nowhere else. Run banda in a desktop session with a keychain (Secret Service on Linux) to make a wallet."
						action="Check again"
						{...(onCheckKeychain === undefined ? {} : { onAction: onCheckKeychain })}
					/>
				) : null}
				{wallets.length === 0 ? (
					<Rows>
						<RowOf
							title="No wallet yet"
							detail="Make one, put money in it, then choose which agents may read it."
							end={create}
						/>
					</Rows>
				) : (
					<>
						<Rows>
							{wallets.map((wallet) => (
								<WalletRow key={wallet.address} wallet={wallet} onOpen={() => onOpen?.(wallet.address)} />
							))}
						</Rows>
						<span className="flex">{create}</span>
					</>
				)}
				<p className="text-meta text-ink-2">{ANY_PROGRAM}</p>
			</Block>
			{archived.length === 0 ? null : (
				<Block title="Archived" note="Agents can't use them and they don't send. Their keys stay in your keychain.">
					<Rows>
						{archived.map((wallet) => (
							<WalletRow key={wallet.address} wallet={wallet} onOpen={() => onOpen?.(wallet.address)} />
						))}
					</Rows>
				</Block>
			)}
			{orphans.length === 0 ? (
				onFindOrphans === undefined ? null : (
					<Block
						title="Keys without a wallet"
						note="A wallet whose making stopped, or a backup restored from before one was made, can leave a key in your keychain that no wallet in this home names."
					>
						<Rows>
							<RowOf
								lead={<KeyRoundIcon className="size-4 shrink-0 text-ink-2" />}
								title={
									orphanSearch === "none"
										? "No key without a wallet"
										: orphanSearch === "unlisted"
											? "This keychain can't list its keys"
											: "Look for keys without a wallet"
								}
								detail="Your computer may ask you to let banda read its keychain."
								end={
									<Button variant="outline" size="sm" disabled={orphanSearch === "finding"} onClick={onFindOrphans}>
										{orphanSearch === "finding" ? "Looking…" : orphanSearch === undefined ? "Look" : "Look again"}
									</Button>
								}
							/>
						</Rows>
					</Block>
				)
			) : (
				<Block
					title="Keys without a wallet"
					note={`Your keychain holds these keys, and no wallet in this home names them: a wallet whose making stopped, or one a backup restored from before it was made. One may hold money: export its key before you delete it. banda never deletes or uses them on its own.${onExportOrphan === undefined ? " Export or delete them in banda's desktop app on this computer." : ""}`}
				>
					<Rows>
						{orphans.map((address) => (
							<RowOf
								key={address}
								lead={<KeyRoundIcon className="size-4 shrink-0 text-ink-2" />}
								title={<span className="font-code">{shortAddress(address)}</span>}
								detail="A key without a wallet"
								end={
									onExportOrphan === undefined && onDeleteOrphan === undefined ? undefined : (
										<span data-orphan-acts="" className="flex flex-wrap justify-end gap-2">
											{onExportOrphan === undefined ? null : (
												<Button variant="outline" size="sm" onClick={() => onExportOrphan(address)}>
													Export
												</Button>
											)}
											{onDeleteOrphan === undefined ? null : (
												<Confirm
													title={`Delete the key of ${shortAddress(address)}?`}
													body="It goes from your keychain for good. Any money at this address is lost unless you saved its key somewhere else."
													action="Delete"
													onConfirm={() => onDeleteOrphan(address)}
												>
													<Button variant="outline" size="sm">
														Delete
													</Button>
												</Confirm>
											)}
										</span>
									)
								}
							/>
						))}
					</Rows>
				</Block>
			)}
			<Block
				title="Networks"
				note="banda reads balances through these. Each learns your wallets' addresses and this computer's IP address."
			>
				<Rows>
					{rpc.map((one) =>
						editing !== undefined && editing.network === (one.id ?? one.network) ? (
							<RpcForm
								key={one.network}
								rpc={one}
								editing={editing}
								onSave={onSaveRpc === undefined ? undefined : (url) => onSaveRpc(one.id ?? one.network, url)}
								onDefault={() => onDefaultRpc?.(one.id ?? one.network)}
								onCancel={onCancelRpc}
							/>
						) : (
							<RowOf
								key={one.network}
								lead={<GlobeIcon className="size-4 shrink-0 text-ink-2" />}
								title={one.network}
								detail={
									<span className="flex flex-col">
										{/* the code font for a URL alone: words in it would read as an RPC called that */}
										{one.url === undefined ? (
											<span>None set</span>
										) : (
											<span className="font-code [overflow-wrap:anywhere]">{one.url}</span>
										)}
										{one.url === undefined ? null : one.byDefault ? (
											<span>banda's default, a public endpoint</span>
										) : (
											<span>Set by you</span>
										)}
										{one.unreachable === undefined ? null : (
											<span data-unreachable="" className="flex items-start gap-1 text-danger">
												<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
												Not answering since {one.unreachable}: balances are unknown.
											</span>
										)}
										{one.otherChain !== true ? null : (
											<span data-other-chain="" className="flex items-start gap-1 text-danger">
												<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
												Serves another chain: set an RPC of {one.network}.
											</span>
										)}
										{one.problem === undefined ? null : (
											<span className="flex items-start gap-1 text-danger">
												<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
												{one.problem}
											</span>
										)}
										{one.logs ? null : (
											<span className="flex items-start gap-1">
												<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
												It refuses log queries, so money coming in isn't listed.
											</span>
										)}
									</span>
								}
								end={
									rpcHere ? (
										<Button
											variant="outline"
											size="sm"
											aria-label={`Change ${one.network}'s RPC`}
											disabled={editing !== undefined}
											ref={(button) => {
												if (button === null || changed.current !== (one.id ?? one.network)) return;
												changed.current = undefined;
												button.focus();
											}}
											onClick={() => {
												changed.current = one.id ?? one.network;
												onChangeRpc?.(one.id ?? one.network);
											}}
										>
											Change
										</Button>
									) : null
								}
							/>
						),
					)}
				</Rows>
			</Block>
		</>
	);
}

// ── A wallet ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A wallet's balance, as large as the page's one figure, with Send and Receive beneath. */
export function WalletHero({
	wallet,
	sends = true,
	canSend = true,
	canReceive = true,
	onSend,
	onReceive,
	onCopyAddress,
}: {
	wallet: ShownWallet;
	/** Whether this build sends from a wallet at all: none shows no Send. */
	sends?: boolean;
	canSend?: boolean;
	canReceive?: boolean;
	onSend?: (() => void) | undefined;
	onReceive?: (() => void) | undefined;
	/**
	 * Copy the whole address, once the daemon says it may leave banda (as Receive asks, marking it disclosed); none draws
	 * no copy, nor does a wallet whose Receive is closed.
	 */
	onCopyAddress?: (() => void) | undefined;
}) {
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-col gap-1">
				<span className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
					{/* the address leaves banda as Receive gives it: never before the key is saved or its saving skipped (H-005) */}
					<Address
						address={wallet.address}
						network={wallet.network}
						testnet={wallet.testnet === true}
						copy={canReceive && wallet.backup !== "unsaved" ? onCopyAddress : undefined}
					/>
					{/* the quiet mark that no copy of the key is saved, as its row has it: the notice waits until it holds
					    money (H-273) */}
					{wallet.backup === "saved" ? null : (
						<span data-unsaved="" className="flex items-center gap-1">
							<KeyRoundIcon className="size-3 shrink-0" />
							Not backed up
						</span>
					)}
				</span>
				{known(wallet) ? (
					<>
						{wallet.usdc === undefined ? (
							<span className="text-display font-semibold text-ink tabular-nums">
								{wallet.eth} <span className="text-heading font-medium text-ink-2">ETH</span>
							</span>
						) : (
							<>
								<span className="text-display font-semibold text-ink tabular-nums">
									{wallet.usdc} <span className="text-heading font-medium text-ink-2">USDC</span>
								</span>
								<span className="text-ui text-ink-2 tabular-nums">
									{wallet.eth} ETH{wallet.fiat === undefined ? null : ` · ${wallet.fiat}`}
								</span>
							</>
						)}
						<span className="text-meta text-ink-2">Read {wallet.read}</span>
					</>
				) : wallet.unmade !== undefined ? (
					<>
						<span className="text-display font-semibold text-ink-2">
							{wallet.unmade === "creating" ? "Not made yet" : "Being removed"}
						</span>
						<span className="text-meta text-ink-2">{UNMADE_WORDS[wallet.unmade]}</span>
					</>
				) : wallet.reading === true ? (
					<>
						<span className="text-display font-semibold text-ink-2">Reading the balance…</span>
						<span className="text-meta text-ink-2">banda is asking {wallet.network} for it.</span>
					</>
				) : (
					<>
						<span className="text-display font-semibold text-ink-2">Balance unknown</span>
						<span data-unreachable="" className="text-meta text-ink-2">
							{wallet.unreachable === undefined
								? "The network isn't answering."
								: `banda can't reach ${wallet.network} since ${wallet.unreachable}.`}
							{wallet.last === undefined ? null : ` Last read: ${wallet.last}.`}
						</span>
					</>
				)}
			</div>
			<span className="flex gap-2">
				{sends ? (
					<Button disabled={!canSend} onClick={onSend}>
						<ArrowUpRightIcon />
						Send
					</Button>
				) : null}
				<Button variant="outline" disabled={!canReceive} onClick={onReceive}>
					<ArrowDownLeftIcon />
					Receive
				</Button>
			</span>
		</section>
	);
}

export type { WalletTab };

/** The tabs a wallet's page has, in order, and their names. */
const TABS: readonly { value: WalletTab; label: string }[] = [
	{ value: "activity", label: "Activity" },
	{ value: "recipients", label: "Recipients" },
	{ value: "agents", label: "Agents" },
	{ value: "wallet", label: "Wallet" },
];

/** Where a page's way back goes: the page it opened from, and how to get there. */
export type WalletParent = {
	readonly title: string;
	readonly href: string;
	readonly onBack?: (() => void) | undefined;
};

const DEFAULT_PARENT: WalletParent = { title: "Wallets", href: "#" };

/**
 * One wallet, opened from Settings → Wallets: its balance, Send and Receive, the notices it has (at most one of each
 * kind), and its four tabs.
 */
export function WalletPage({
	wallet,
	phone = false,
	tab = "activity",
	tabs = ["activity", "recipients", "agents", "wallet"],
	parent = DEFAULT_PARENT,
	notices,
	activity,
	recipients,
	agents,
	options,
	sends,
	canSend,
	canReceive,
	onTab,
	onSend,
	onReceive,
	onCopyAddress,
}: {
	wallet: ShownWallet;
	phone?: boolean;
	tab?: WalletTab;
	/** The tabs it has; every one unless told. */
	tabs?: readonly WalletTab[];
	parent?: WalletParent;
	notices?: ReactNode;
	activity?: ReactNode;
	recipients?: ReactNode;
	agents?: ReactNode;
	options?: ReactNode;
	sends?: boolean;
	canSend?: boolean;
	canReceive?: boolean;
	onTab?: ((tab: WalletTab) => void) | undefined;
	onSend?: (() => void) | undefined;
	onReceive?: (() => void) | undefined;
	onCopyAddress?: (() => void) | undefined;
}) {
	const offline = wallet.offline !== undefined || wallet.archived === true;
	return (
		<SettingsPage
			title={wallet.name}
			icon={WalletIcon}
			parent={{ title: parent.title, href: parent.href }}
			phone={phone}
			{...(parent.onBack === undefined ? {} : { onBack: parent.onBack })}
		>
			<WalletHero
				wallet={wallet}
				{...(sends === undefined ? {} : { sends })}
				canSend={canSend ?? !offline}
				canReceive={canReceive ?? (wallet.offline !== "code" && wallet.backup !== "unsaved" && !unopenable(wallet))}
				onSend={onSend}
				onReceive={onReceive}
				onCopyAddress={onCopyAddress}
			/>
			{/* a wallet with no notice draws no space for them */}
			{notices === undefined ? null : <div className="flex flex-col gap-2 empty:hidden">{notices}</div>}
			<Tabs
				{...(onTab === undefined
					? { defaultValue: tab }
					: { value: tab, onValueChange: (next) => onTab(next as WalletTab) })}
				className="gap-6"
			>
				<TabsList aria-label={wallet.name} className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
					{TABS.filter((one) => tabs.includes(one.value)).map((one) => (
						<TabsTrigger key={one.value} value={one.value}>
							{one.label}
						</TabsTrigger>
					))}
				</TabsList>
				<TabsContent value="activity" className="flex flex-col gap-6">
					{activity}
				</TabsContent>
				<TabsContent value="recipients" className="flex flex-col gap-8">
					{recipients}
				</TabsContent>
				<TabsContent value="agents" className="flex flex-col gap-8">
					{agents}
				</TabsContent>
				<TabsContent value="wallet" className="flex flex-col gap-8">
					{options}
				</TabsContent>
			</Tabs>
		</SettingsPage>
	);
}

// ── Activity: the transaction list ──────────────────────────────────────────────────────────────────────────────────

/**
 * A payment's state as the owner reads it: C12's states (the stored `Queued` reads "In line"), the x402 authorization's,
 * and the two kinds of row the chain alone tells: money that came in, and a nonce spent outside banda.
 */
export type PaymentState =
	| "waiting"
	| "in_line"
	| "signed"
	| "sent"
	| "included"
	| "confirmed"
	| "failed"
	| "cancelled"
	| "refused"
	| "not_paid"
	| "restored"
	| "authorized"
	| "handed"
	| "settlement_pending"
	| "settled"
	| "expired"
	| "received"
	| "outside";

/** Where the money is: gone from the wallet, not gone yet, or kept for good (struck through). */
type Money = "left" | "pending" | "kept";

type StatusWords = { icon?: LucideIcon; words: string; tone?: "alive" | "danger"; busy?: boolean; money: Money };

/** Each state's words, its icon, and where the money is: a payment that ended without it leaving is struck through. */
export const STATUS: Record<PaymentState, StatusWords> = {
	waiting: { icon: ClockIcon, words: "Waiting on you", money: "pending" },
	in_line: { icon: HourglassIcon, words: "In line", money: "pending" },
	signed: { icon: CircleDashedIcon, words: "May have sent", busy: true, money: "left" },
	sent: { words: "Sent", busy: true, money: "left" },
	included: { words: "Included, confirming", busy: true, money: "left" },
	confirmed: { icon: CheckIcon, words: "Confirmed", tone: "alive", money: "left" },
	failed: { icon: TriangleAlertIcon, words: "Failed", tone: "danger", money: "kept" },
	cancelled: { icon: CircleSlashIcon, words: "Cancelled", money: "kept" },
	refused: { icon: CircleSlashIcon, words: "Refused", money: "kept" },
	not_paid: { icon: ClockIcon, words: "Not paid", money: "kept" },
	restored: { icon: ArchiveRestoreIcon, words: "Restored, never sent", money: "kept" },
	authorized: { icon: KeyRoundIcon, words: "Authorized", busy: true, money: "left" },
	handed: { words: "Waiting to settle", busy: true, money: "left" },
	settlement_pending: { icon: ClockIcon, words: "Settling, as the service says", money: "left" },
	settled: { icon: CheckIcon, words: "Settled", tone: "alive", money: "left" },
	expired: { icon: ClockIcon, words: "Expired, nothing paid", money: "kept" },
	received: { icon: CheckIcon, words: "Received", tone: "alive", money: "left" },
	outside: { icon: ExternalLinkIcon, words: "Sent outside banda", money: "left" },
};

/** A state's icon and words, small, as a row's second line says it. */
export function PaymentStatus({ state, detail }: { state: PaymentState; detail?: string | undefined }) {
	const status = STATUS[state];
	const Icon = status.icon;
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1 text-meta",
				status.tone === "danger" ? "text-danger" : "text-ink-2",
			)}
		>
			{status.busy && Icon === undefined ? (
				<Spinner className="size-3" />
			) : Icon === undefined ? null : (
				<Icon className={cn("size-3 shrink-0", status.tone === "alive" && "text-alive")} />
			)}
			<span className="truncate">
				{status.words}
				{detail === undefined ? null : `: ${detail}`}
			</span>
		</span>
	);
}

export type TxRowView = {
	readonly id: string;
	readonly day: string;
	readonly direction: "out" | "in";
	/** Who paid: an agent, or the owner's own Send; nobody for money that came in or left outside banda. */
	readonly by?: Who | "you" | undefined;
	/** The recipient's name, or its address or endpoint; for money in, who sent it. */
	readonly counterpart: string;
	readonly x402?: boolean | undefined;
	/** Absent where it is not known: what left by a transaction signed outside banda (H-210). */
	readonly amount?: string | undefined;
	readonly token: Token;
	readonly state: PaymentState;
	readonly detail?: string | undefined;
	readonly time: string;
	/** The row on the network's block explorer, opened only by the owner's tap (H-201, H-282). */
	readonly explorer?: string | undefined;
};

/** A row of a wallet's activity that moves no money: its key shown (UC-02 A2, H-266). */
export type NoteRowView = {
	readonly kind: "note";
	readonly id: string;
	readonly day: string;
	readonly title: string;
	readonly time: string;
};

/** A row of a wallet's activity: money in or out, or a note of something done to the wallet. */
export type ActivityRowView = TxRowView | NoteRowView;

const isNote = (row: ActivityRowView): row is NoteRowView => "kind" in row && row.kind === "note";

/** A note in the activity: what was done to the wallet, and when. Nothing to open. */
function NoteRow({ row }: { row: NoteRowView }) {
	return (
		<span data-note="" className="flex w-full items-center gap-3 px-3.5 py-2.5">
			<span
				aria-hidden="true"
				className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-3 text-ink-2"
			>
				<KeyRoundIcon className="size-3.5" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-ui text-ink">{row.title}</span>
				<span className="text-meta text-ink-2">{row.time}</span>
			</span>
		</span>
	);
}

function Lead({ row }: { row: TxRowView }) {
	if (row.direction === "in" || row.by === undefined)
		return (
			<span
				aria-hidden="true"
				className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-3 text-ink-2"
			>
				{row.direction === "in" ? (
					<ArrowDownLeftIcon className="size-3.5" />
				) : (
					<ArrowLeftRightIcon className="size-3.5" />
				)}
			</span>
		);
	if (row.by === "you")
		return (
			<span
				aria-hidden="true"
				className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-3 text-ink-2"
			>
				<UserRoundIcon className="size-3.5" />
			</span>
		);
	return <Face face={row.by.face} name={row.by.name} size="message" />;
}

/**
 * One row of the list: who, to whom, in what state, how much; its explorer link beside it. A button that opens the
 * payment where there is one to open (`onOpen`), plain text where there is none: money that came in, or left outside
 * banda, is no control.
 */
export function TxRow({ row, onOpen }: { row: TxRowView; onOpen?: (() => void) | undefined }) {
	const money = STATUS[row.state].money;
	const who = row.by === undefined ? undefined : row.by === "you" ? "You" : row.by.name;
	const title =
		row.direction === "in"
			? `From ${row.counterpart}`
			: who === undefined
				? row.counterpart
				: `${who} paid ${row.counterpart}`;
	const body = (
		<>
			<Lead row={row} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 items-center gap-1.5 text-ui text-ink">
					<span className="truncate">{title}</span>
					{row.x402 === true ? (
						<span className="shrink-0 rounded-chip border border-line-soft px-1.5 text-meta text-ink-2">x402</span>
					) : null}
				</span>
				<span className="flex min-w-0 items-center gap-1.5">
					<PaymentStatus state={row.state} detail={row.detail} />
					<span className="shrink-0 text-meta text-ink-2">· {row.time}</span>
				</span>
			</span>
			{row.amount === undefined ? null : (
				<span
					className={cn(
						"shrink-0 text-ui tabular-nums",
						row.direction === "in" ? "text-alive" : money === "left" ? "text-ink" : "text-ink-2",
						money === "kept" && "line-through",
					)}
				>
					{row.direction === "in" ? "+" : money === "left" ? "−" : ""}
					{row.amount} {row.token}
				</span>
			)}
		</>
	);
	const inner = cn(
		"flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3.5 text-left",
		row.explorer === undefined ? "pr-3.5" : "pr-1",
	);
	return (
		<span className={cn("flex w-full items-center", onOpen !== undefined && "hover:bg-paper-2")}>
			{onOpen === undefined ? (
				<span data-row="" className={inner}>
					{body}
				</span>
			) : (
				<button type="button" onClick={onOpen} className={inner}>
					{body}
				</button>
			)}
			{row.explorer === undefined ? null : (
				<Button asChild variant="ghost" size="icon-sm" className="mr-2 shrink-0 text-ink-2">
					<a href={row.explorer} target="_blank" rel="noopener noreferrer" aria-label="Open in the block explorer">
						<ExternalLinkIcon />
					</a>
				</Button>
			)}
		</span>
	);
}

/**
 * The wallet's activity: its payments from the store, in every state, and what came in, read from the chain; grouped
 * by day, newest first. What the list cannot know is said, never left out: an RPC that serves no logs, a range not yet
 * read.
 */
export function TransactionList({
	rows,
	unmade,
	incomplete,
	more = false,
	loading = false,
	failed,
	onRetry,
	onMore,
	loadingMore = false,
}: {
	/** Newest first: money in and out, and notes of what was done to the wallet (its key shown). */
	rows: readonly ActivityRowView[];
	/** The wallet is not made yet, or being removed: nothing is read for it, which the empty list says. */
	unmade?: "creating" | "removing" | undefined;
	/** Why money coming in is listed only so far back: "Complete since 2 Nov: earlier blocks aren't read yet". */
	incomplete?: string | undefined;
	/** Older rows than these are listed: Earlier reads the next page. */
	more?: boolean;
	onMore?: (() => void) | undefined;
	loadingMore?: boolean;
	loading?: boolean;
	/** Why the list could not be read, in the owner's words; Try again reads it again. Rows given with it are the last read. */
	failed?: string | undefined;
	onRetry?: () => void;
}) {
	const notice =
		failed === undefined ? null : (
			<WalletNotice
				icon={TriangleAlertIcon}
				title="Couldn't read this wallet's activity"
				body={
					rows.length === 0
						? failed
						: `${/[.!?]$/.test(failed) ? failed : `${failed}.`} What's below is what banda read last, and may be out of date.`
				}
				{...(onRetry === undefined ? {} : { action: "Try again", onAction: onRetry })}
			/>
		);
	if (notice !== null && rows.length === 0) return notice;
	if (loading)
		return (
			<Rows>
				{[0, 1, 2].map((one) => (
					<div key={one} className="flex items-center gap-3 px-3.5 py-3">
						<span className="size-7 shrink-0 animate-pulse rounded-full bg-paper-3" />
						<span className="flex flex-1 flex-col gap-1.5">
							<span className="h-3 w-2/5 animate-pulse rounded bg-paper-3" />
							<span className="h-2.5 w-1/4 animate-pulse rounded bg-paper-3" />
						</span>
					</div>
				))}
			</Rows>
		);
	const days = [...new Set(rows.map((row) => row.day))];
	return (
		<div className="flex flex-col gap-4">
			{notice}
			{incomplete === undefined ? null : (
				<p className="flex items-start gap-1.5 text-meta text-ink-2">
					<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
					{incomplete}
				</p>
			)}
			{rows.length === 0 ? (
				<Rows>
					{/* a list banda could not read whole never says nothing came in: only that it read nothing */}
					<RowOf
						title={incomplete === undefined || unmade !== undefined ? "Nothing yet" : "Nothing listed"}
						detail={
							unmade !== undefined
								? UNMADE_WORDS[unmade]
								: incomplete === undefined
									? "Money that comes in, and every payment from this wallet, will show here."
									: "Nothing came in or went out in what banda has read so far."
						}
					/>
				</Rows>
			) : (
				days.map((day) => (
					<section key={day} className="flex flex-col gap-2">
						<h3 className="text-meta font-medium text-ink-2">{day}</h3>
						<Rows>
							{rows
								.filter((row) => row.day === day)
								.map((row) => (isNote(row) ? <NoteRow key={row.id} row={row} /> : <TxRow key={row.id} row={row} />))}
						</Rows>
					</section>
				))
			)}
			{more ? (
				<Button variant="ghost" size="sm" className="self-center" disabled={loadingMore} onClick={onMore}>
					{loadingMore ? <Spinner className="size-3.5" /> : null}
					Earlier
				</Button>
			) : null}
		</div>
	);
}

// ── A payment, opened ───────────────────────────────────────────────────────────────────────────────────────────────

/** One signed version at the payment's nonce: the first, a fee raised, the owner's cancel. */
export type VersionView = { readonly label: string; readonly at: string; readonly fee: string; readonly hash: string };

export type CancelState = "offer" | "cancelling" | "cancelled" | "paid_anyway";

/** A line of a payment's facts: a label, and what it is. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex gap-3 px-3.5 py-2.5">
			<span className="w-24 shrink-0 text-meta text-ink-2">{label}</span>
			<span className="min-w-0 flex-1 text-ui text-ink [overflow-wrap:anywhere]">{children}</span>
		</div>
	);
}

/**
 * A payment, opened from its row or its card: what it is, every fact the owner may check, each version signed at its
 * nonce, and Cancel while it is Sent. A cancel is a payment of nothing to the wallet itself at the same nonce: whichever
 * the network takes decides, and a cancel taken is never reported paid.
 */
export function PaymentDetail({
	title,
	amount,
	token,
	fiat,
	state,
	stateDetail,
	to,
	from,
	reason,
	by,
	approved,
	versions = [],
	cancel,
	explain,
}: {
	title: string;
	amount: string;
	token: Token;
	fiat?: string | undefined;
	state: PaymentState;
	stateDetail?: string | undefined;
	to: { name?: string | undefined; identity: string; network: Network; endpoint?: string | undefined };
	from: string;
	reason?: string | undefined;
	by?: Who | "you" | undefined;
	approved?: string | undefined;
	versions?: readonly VersionView[];
	cancel?: CancelState | undefined;
	/** What the state means here, in a sentence: a failure's fee, a restore, a nonce spent elsewhere. */
	explain?: { tone: "quiet" | "danger"; title: string; body: string } | undefined;
}) {
	const money = STATUS[state].money;
	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-1">
				<span className="flex items-center gap-2 text-meta text-ink-2">
					{by === undefined ? null : by === "you" ? (
						<UserRoundIcon className="size-3.5" />
					) : (
						<Face face={by.face} name={by.name} size="mention" />
					)}
					{title}
				</span>
				<span
					className={cn(
						"text-display font-semibold text-ink tabular-nums",
						money === "kept" && "text-ink-2 line-through",
					)}
				>
					{amount} <span className="text-heading font-medium text-ink-2">{token}</span>
				</span>
				<span className="flex flex-wrap items-center gap-x-2 text-ui text-ink-2">
					<PaymentStatus state={state} detail={stateDetail} />
					{fiat === undefined ? null : <span className="text-meta">{fiat}</span>}
				</span>
			</section>
			{explain === undefined ? null : (
				<WalletNotice
					icon={explain.tone === "danger" ? TriangleAlertIcon : ClockIcon}
					title={explain.title}
					body={explain.body}
					tone={explain.tone}
				/>
			)}
			<Rows>
				<Fact label="To">
					{to.name === undefined ? null : <span className="block font-medium">{to.name}</span>}
					{to.endpoint === undefined ? null : <span className="block">{to.endpoint}</span>}
					<span className="block font-code text-meta">{to.identity}</span>
					<span className="block text-meta text-ink-2">on {to.network}</span>
				</Fact>
				<Fact label="From">{from}</Fact>
				{reason === undefined ? null : (
					<Fact label={by === undefined || by === "you" ? "Note" : `${by.name} said`}>
						<q className="text-ink">{reason}</q>
					</Fact>
				)}
				{approved === undefined ? null : <Fact label="Approved">{approved}</Fact>}
			</Rows>
			{versions.length === 0 ? null : (
				<Block title="On the network" note="Each version is signed at the same place in line; only one can land.">
					<Rows>
						{versions.map((version) => (
							<RowOf
								key={version.hash}
								title={version.label}
								detail={
									<span>
										{version.at} · fee {version.fee} · <span className="font-code">{shortAddress(version.hash)}</span>
									</span>
								}
								end={
									<Button variant="ghost" size="icon-sm" aria-label="Open in the block explorer" className="text-ink-2">
										<ExternalLinkIcon />
									</Button>
								}
							/>
						))}
					</Rows>
				</Block>
			)}
			{cancel === undefined ? null : cancel === "offer" ? (
				<div className="flex flex-col items-start gap-1.5">
					<Button variant="outline">Cancel payment</Button>
					<span className="text-meta text-ink-2">
						Sends nothing to this wallet in its place, for a small fee. If the payment lands first, it stays paid.
					</span>
				</div>
			) : cancel === "cancelling" ? (
				<span className="flex items-center gap-1.5 text-ui text-ink-2">
					<Spinner className="size-3.5" />
					Cancelling: whichever the network takes first decides.
				</span>
			) : cancel === "cancelled" ? (
				<span className="flex items-center gap-1.5 text-ui text-ink-2">
					<CircleSlashIcon className="size-3.5" />
					Cancelled. Nothing was paid; the cancel's fee was spent.
				</span>
			) : (
				<span className="flex items-center gap-1.5 text-ui text-ink-2">
					<CheckIcon className="size-3.5 text-alive" />
					The payment landed before the cancel, so it's paid.
				</span>
			)}
		</div>
	);
}

// ── Recipients ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Rule = "always" | "ask" | "deny";

export const RULES: readonly { value: Rule; label: string }[] = [
	{ value: "always", label: "Always" },
	{ value: "ask", label: "Ask" },
	{ value: "deny", label: "Deny" },
];

export type RecipientView = {
	readonly name?: string | undefined;
	readonly kind: "address" | "endpoint";
	/** The identity a rule binds: an address, or an endpoint's origin and path. */
	readonly identity: string;
	/** For an endpoint: who it pays, and in what. */
	readonly payTo?: string | undefined;
	/** Each agent of the wallet's rule: Always is an agent's, Deny holds for all. */
	readonly rules: readonly { agent: Who; rule: Rule }[];
	readonly paid?: string | undefined;
	/** Its address is one character off another recipient's: flagged, never offered as a match. */
	readonly lookalike?: string | undefined;
};

/** What a recipient's rules come to, in words: one rule for all, or each agent's. */
const ruleWords = (rules: RecipientView["rules"]) => {
	const distinct = [...new Set(rules.map((one) => one.rule))];
	const label = (rule: Rule) => RULES.find((one) => one.value === rule)?.label ?? rule;
	if (distinct.length === 1 && distinct[0] !== undefined) return label(distinct[0]);
	return rules.map((one) => `${label(one.rule)} for ${one.agent.name}`).join(" · ");
};

function RecipientRow({ recipient }: { recipient: RecipientView }) {
	const Icon = recipient.kind === "endpoint" ? GlobeIcon : UserRoundIcon;
	return (
		<button type="button" className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-paper-2">
			<span
				aria-hidden="true"
				className="flex size-7 shrink-0 items-center justify-center rounded-full bg-paper-3 text-ink-2"
			>
				<Icon className="size-3.5" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className={cn("truncate text-ui", recipient.name === undefined ? "text-ink-2" : "text-ink")}>
					{recipient.name ?? "No name"}
				</span>
				<span className="truncate font-code text-meta text-ink-2">
					{recipient.kind === "address" ? shortAddress(recipient.identity) : recipient.identity}
				</span>
				{recipient.paid === undefined ? null : <span className="text-meta text-ink-2">{recipient.paid}</span>}
			</span>
			{/* the rules give way to the name: each wraps in its own half, never squeezing the name to a word a line */}
			<span
				className={cn(
					"min-w-0 max-w-[45%] text-right text-meta",
					recipient.rules.every((one) => one.rule === "deny") ? "text-danger" : "text-ink-2",
				)}
			>
				{ruleWords(recipient.rules)}
			</span>
			<ChevronRightIcon className="size-4 shrink-0 text-ink-2" />
		</button>
	);
}

/**
 * The wallet's recipients: who it pays and how, each kept by its address or endpoint, whatever it is called. New ones
 * ask (or, the owner's opt-in, are refused). A rule changed on another device first redraws the list and says so.
 */
export function RecipientsList({
	recipients,
	unknown = "ask",
	stale = false,
}: {
	recipients: readonly RecipientView[];
	unknown?: "ask" | "deny";
	stale?: boolean;
}) {
	return (
		<>
			{stale ? (
				<WalletNotice
					icon={MonitorIcon}
					title="Changed on another device"
					body="Ana's rule was changed on your phone a moment ago, so this list is redrawn. Nothing you did was applied: check it and try again."
				/>
			) : null}
			<Block
				title="Recipients"
				note="Who this wallet pays, and how. A rule holds for the address or endpoint, whatever you call it."
			>
				{recipients.length === 0 ? (
					<Rows>
						<RowOf
							title="No recipients yet"
							detail="The first time an agent pays someone, it asks you, and your answer sets the rule here."
						/>
					</Rows>
				) : (
					<Rows>
						{recipients.map((recipient) => (
							<RecipientRow key={recipient.identity} recipient={recipient} />
						))}
					</Rows>
				)}
			</Block>
			<Block title="New recipients" note="When an agent pays someone not in the list.">
				<Rows>
					<RowOf
						title={unknown === "ask" ? "Ask me" : "Deny"}
						detail={
							unknown === "ask"
								? "The agent asks you on a card; your answer sets the rule."
								: "Agents pay only the recipients above. Asks already open for new ones are refused."
						}
						end={
							<Segmented
								label="New recipients"
								value={unknown}
								options={[
									{ value: "ask", label: "Ask" },
									{ value: "deny", label: "Deny" },
								]}
							/>
						}
					/>
				</Rows>
			</Block>
		</>
	);
}

/**
 * One recipient: its name (renaming it changes every card, never what the rule binds), what it is, each agent's rule,
 * and Forget. Deny holds for every agent of the wallet, so setting it on one sets it on all.
 */
export function RecipientDetail({ recipient, editing = false }: { recipient: RecipientView; editing?: boolean }) {
	const denied = recipient.rules.every((one) => one.rule === "deny");
	return (
		<div className="flex flex-col gap-8">
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
			<label className="flex flex-col gap-1.5">
				<span className="text-ui font-medium text-ink">Name</span>
				<Input
					defaultValue={recipient.name ?? ""}
					placeholder="Name this recipient"
					autoFocus={editing}
					className="text-heading"
				/>
				<span className="text-meta text-ink-2">Only you and your agents see it. The rule stays on the address.</span>
			</label>
			{recipient.lookalike === undefined ? null : (
				<WalletNotice
					icon={TriangleAlertIcon}
					tone="danger"
					title="Looks like another recipient"
					body={recipient.lookalike}
				/>
			)}
			<Block title={recipient.kind === "endpoint" ? "Endpoint" : "Address"}>
				<Rows>
					<Fact label={recipient.kind === "endpoint" ? "Endpoint" : "Address"}>
						<span className="font-code text-meta">{recipient.identity}</span>
					</Fact>
					{recipient.payTo === undefined ? null : (
						<Fact label="Pays">
							<span className="font-code text-meta">{recipient.payTo}</span>
							<span className="block text-meta text-ink-2">
								If it asks to pay anyone else, it's a new recipient and asks you again.
							</span>
						</Fact>
					)}
					<Fact label="Network">Base</Fact>
				</Rows>
			</Block>
			<Block
				title="Rule"
				note={
					denied
						? "No agent pays it. You can still send to it yourself."
						: "Always pays whatever the agent asks, up to what's in the wallet. Deny holds for every agent."
				}
			>
				<Rows>
					{recipient.rules.map((one) => (
						<RowOf
							key={one.agent.name}
							lead={<Face face={one.agent.face} name={one.agent.name} size="message" />}
							title={one.agent.name}
							end={<Segmented label={`${one.agent.name}'s rule`} value={one.rule} options={RULES} />}
						/>
					))}
				</Rows>
			</Block>
			{recipient.paid === undefined ? null : (
				<Block title="Paid">
					<p className="text-ui text-ink-2">{recipient.paid}</p>
				</Block>
			)}
			<Button variant="destructive" className="self-start">
				Forget recipient
			</Button>
		</div>
	);
}

// ── Agents ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Who may read the wallet: each agent of the band, switched on or off. Agents that share it share its balance. */
export function WalletAgents({
	agents,
	disabled,
	onSwitch,
}: {
	agents: readonly { agent: Who; on: boolean; detail?: string }[];
	/** Why no switch moves (`unswitchable`): an archived wallet, one being removed or not made yet. */
	disabled?: string | undefined;
	/** Switch the wallet on or off for an agent, by its id. */
	onSwitch?: ((agent: string, on: boolean) => void) | undefined;
}) {
	const shared = sharedBy(agents.filter((one) => one.on).map((one) => one.agent.name));
	const said = disabled ?? shared;
	return (
		<Block title="Agents" note="Which agents may read this wallet: its address and balance.">
			<Rows>
				{agents.map((one) => (
					// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
					<label key={one.agent.name} className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
						<Face face={one.agent.face} name={one.agent.name} size="message" />
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="text-ui text-ink">{one.agent.name}</span>
							{one.detail === undefined ? null : <span className="text-meta text-ink-2">{one.detail}</span>}
						</span>
						<Switch
							checked={one.on}
							disabled={disabled !== undefined}
							aria-label={`${one.agent.name} may read it`}
							onCheckedChange={(on) => onSwitch?.(one.agent.id ?? one.agent.name, on)}
						/>
					</label>
				))}
			</Rows>
			{said === undefined ? null : <p className="text-meta text-ink-2">{said}</p>}
			<p className="text-meta text-ink-2">{PROVIDER_SEES}</p>
		</Block>
	);
}

/** The wallet in an agent's panel (Access): the ones it may read, or a way to give it one. */
export function AgentWallets({
	agent,
	wallets,
	onSwitch,
	onCreate,
}: {
	agent: string;
	/** Each wallet, whether it is on for the agent, and why its switch does not move, if it does not (`unswitchable`). */
	wallets: readonly { wallet: ShownWallet; on: boolean; disabled?: string | undefined }[];
	onSwitch?: ((address: string, on: boolean) => void) | undefined;
	/** Make a wallet with this agent already chosen. */
	onCreate?: (() => void) | undefined;
}) {
	return (
		<Block title="Wallets" note={`The wallets ${agent} may read: their address and balance.`}>
			{wallets.length === 0 ? (
				<Rows>
					{/* the action beneath the words: in a panel's width beside them, a long name would leave the words none */}
					<div data-no-wallet="" className="flex flex-col items-start gap-2 px-3.5 py-2.5">
						<span className="flex min-w-0 flex-col self-stretch">
							<span className="text-ui text-ink [overflow-wrap:anywhere]">{agent} has no wallet</span>
							<span className="text-meta text-ink-2">Give it one to read its address and balance.</span>
						</span>
						<Button variant="outline" size="sm" className="max-w-full" onClick={onCreate}>
							<PlusIcon />
							<span className="truncate">Give {agent} a wallet</span>
						</Button>
					</div>
				</Rows>
			) : (
				<Rows>
					{wallets.map(({ wallet, on, disabled }) => (
						// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
						<label key={wallet.address} className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
							<WalletMark />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="truncate text-ui text-ink">{wallet.name}</span>
									{wallet.testnet === true ? <TestnetMark /> : null}
								</span>
								{/* the network and the short address tell same-named wallets apart, here as in Settings (H-041) */}
								<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-ink-2">
									<span data-network="" className="min-w-0 [overflow-wrap:anywhere]">
										{wallet.network}
									</span>
									<span data-short="" className="font-code">
										{shortAddress(wallet.address)}
									</span>
								</span>
								{/* a figure is derived and dated (C22): the block and when it was read, or why it is unknown since when
								    and the last reading that answered (H-208), as Settings and the wallet's page say it */}
								<span data-balance="" className="text-meta text-ink-2 [overflow-wrap:anywhere]">
									{!known(wallet)
										? wallet.unmade === "creating"
											? "Not made yet"
											: wallet.unmade === "removing"
												? "Being removed"
												: wallet.reading === true
													? "Reading the balance…"
													: "Balance unknown"
										: wallet.usdc === undefined
											? `${wallet.eth} ETH`
											: `${wallet.usdc} USDC · ${wallet.eth} ETH`}
								</span>
								{known(wallet) ? (
									<span data-read="" className="text-meta text-ink-2 [overflow-wrap:anywhere]">
										Read {wallet.read}
									</span>
								) : wallet.reading === true || wallet.unmade !== undefined ? null : (
									<span data-unreachable="" className="text-meta text-ink-2 [overflow-wrap:anywhere]">
										{wallet.unreachable === undefined
											? `${wallet.network} isn't answering.`
											: `${wallet.network} not answering since ${wallet.unreachable}.`}
										{wallet.last === undefined ? null : ` Last read: ${wallet.last}.`}
									</span>
								)}
								{/* why the agent cannot use it now (H-317); the switch still moves (UC-05), and what it allows
								    applies once the reason is gone */}
								<OfflineLine wallet={wallet} />
								{disabled === undefined ? null : (
									<span data-unswitchable="" className="text-meta text-ink-2">
										{disabled}
									</span>
								)}
							</span>
							<Switch
								checked={on}
								aria-label={`${agent} may read ${wallet.name} (${shortAddress(wallet.address)})`}
								disabled={disabled !== undefined}
								onCheckedChange={(next) => onSwitch?.(wallet.address, next)}
							/>
						</label>
					))}
				</Rows>
			)}
			{wallets.length === 0 ? null : <p className="text-meta text-ink-2">{PROVIDER_SEES}</p>}
		</Block>
	);
}

// ── Wallet: its key, its network, archive and remove ────────────────────────────────────────────────────────────────

/**
 * The wallet's own settings: its key (backed up or not, and seeing it again, which only the computer banda runs on
 * can do), its network, and archive and remove.
 */
export function WalletOptions({
	wallet,
	host = true,
	shows = host,
	saves = true,
	laterKey = "unknown",
	rpc,
	remove,
	archive,
	onSaveKey,
	onShowKey,
	onArchive,
}: {
	wallet: ShownWallet;
	/** Whether this screen is on the computer banda runs on: a phone or a browser elsewhere never sees a key. */
	host?: boolean;
	/** Whether this screen can show the key again: only banda's desktop app does, after the computer asks it's you. */
	shows?: boolean;
	/**
	 * Whether a key on this computer can be shown and checked now: false while the wallet's key is offline (gone,
	 * another's, another home's signing) or the home's id is lost, when no Save your key is offered (H-317).
	 */
	saves?: boolean;
	/** Where the key is shown again, as this screen can tell: never on a computer that cannot ask who you are (H-266). */
	laterKey?: LaterKey;
	rpc: RpcView;
	/** The Remove button, as the page wraps it in its confirmation; a plain one where none is given. */
	remove?: ReactNode;
	/** The Archive button, as the page wraps it in its confirmation; a plain one calling `onArchive` where none is given. */
	archive?: ReactNode;
	onSaveKey?: (() => void) | undefined;
	onShowKey?: (() => void) | undefined;
	/** Archive the wallet, or bring it back when it is archived. */
	onArchive?: (() => void) | undefined;
}) {
	return (
		<>
			<Block title="Key" note="The key is the wallet: whoever has it can spend everything in it.">
				<Rows>
					<RowOf
						lead={<KeyRoundIcon className="size-4 shrink-0 text-ink-2" />}
						title={wallet.backup === "saved" ? "Backed up" : "Not backed up"}
						detail={
							wallet.backup === "saved"
								? "You saved the key and pasted it back to check it."
								: "If this computer is lost, so is what's in this wallet."
						}
						end={
							wallet.backup === "saved" || !saves ? null : (
								<Button variant="outline" size="sm" disabled={!host} onClick={onSaveKey}>
									Save your key
								</Button>
							)
						}
					/>
					<RowOf
						title="Show key"
						detail={
							!host
								? "Open banda's desktop app on your computer to see it."
								: wallet.archived === true
									? "Bring the wallet back to see its key."
									: shows
										? "Your computer asks it's you first."
										: laterKey === "never"
											? "This computer can't confirm it's you, so banda doesn't show the key again here."
											: "Only banda's desktop app on this computer shows it again, if it's a Mac with Touch ID."
						}
						end={
							<Button variant="outline" size="sm" disabled={!shows} onClick={onShowKey}>
								Show
							</Button>
						}
					/>
				</Rows>
			</Block>
			<Block title="Network">
				<Rows>
					<RowOf
						lead={<GlobeIcon className="size-4 shrink-0 text-ink-2" />}
						title={
							wallet.testnet === true ? (
								<span className="flex items-center gap-1.5">
									{wallet.network}
									<TestnetMark />
								</span>
							) : (
								wallet.network
							)
						}
						detail={
							<span>
								Fixed when the wallet was made.{" "}
								{rpc.url === undefined ? (
									"No RPC is set for it."
								) : (
									<>
										Read through <span className="font-code [overflow-wrap:anywhere]">{rpc.url}</span>.
									</>
								)}
							</span>
						}
					/>
				</Rows>
			</Block>
			<Block title={wallet.archived === true ? "Archived" : "Archive or remove"}>
				{/* only a ready wallet is archived and only a ready or archived one removed (the wallet machine) */}
				{wallet.unmade !== undefined ? (
					<Rows>
						<RowOf
							lead={<ArchiveIcon className="size-4 shrink-0 text-ink-2" />}
							title={wallet.unmade === "creating" ? "Not made yet" : "Being removed"}
							detail={
								wallet.unmade === "creating"
									? "It can be archived or removed once it's made."
									: "banda is removing it and its key."
							}
						/>
					</Rows>
				) : (
					<Rows>
						<RowOf
							lead={<ArchiveIcon className="size-4 shrink-0 text-ink-2" />}
							title={wallet.archived === true ? "Unarchive" : "Archive"}
							detail={
								wallet.archived === true
									? "Agents it was on for can use it again."
									: "Agents can't read it. The key stays."
							}
							end={
								archive ?? (
									<Button variant="outline" size="sm" onClick={onArchive}>
										{wallet.archived === true ? "Unarchive" : "Archive"}
									</Button>
								)
							}
						/>
						<RowOf
							title="Remove"
							detail="Deletes its key from your keychain. Only when it's empty."
							end={
								remove ?? (
									<Button variant="destructive" size="sm" disabled={!host}>
										Remove
									</Button>
								)
							}
						/>
					</Rows>
				)}
			</Block>
		</>
	);
}

/** What archiving a wallet asks first; unarchiving asks nothing. */
export const archiveWords = (name: string) => ({
	title: `Archive ${name}?`,
	body: "Agents can't read it. The key stays in your keychain, and you can unarchive it.",
});

/**
 * What removing a wallet asks first, by whether the owner confirmed a copy of its key (H-043, H-046): a key never saved
 * has no copy to spend with, so what reaches its address after is lost for good.
 */
export const removeWords = (name: string, backup: WalletView["backup"]) =>
	backup === "saved"
		? {
				title: `Remove ${name}?`,
				body: "Its key is deleted from your keychain. Whatever is still at its address can then be spent only with the copy you saved.",
			}
		: {
				title: `Remove ${name}?`,
				body: "Its key is deleted from your keychain, and no copy of it was saved. Anything sent to its address after this is lost for good.",
			};

/** Why the daemon refuses to remove a wallet whose address was given out and whose key was never saved (C17). */
export const UNSAVED_DISCLOSED = "the wallet's address was given out and its key was never saved";

/** What a refused removal says, above why. */
export const removeBlockedWords = (name: string) => ({
	title: `${name} can't be removed yet`,
	body: "Removing deletes its key, so banda waits until nothing can be lost:",
});

/** Why a wallet cannot be removed yet, each reason with what to do (C17). */
export function RemoveReasons({ reasons }: { reasons: readonly string[] }) {
	return (
		<ul className="flex flex-col gap-2">
			{reasons.map((reason) => (
				<li key={reason} className="flex items-start gap-2 text-ui text-ink">
					<XIcon className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
					<span className="min-w-0 [overflow-wrap:anywhere]">{reason}</span>
				</li>
			))}
		</ul>
	);
}

/** A dialog's body, as the confirm draws it: title, what happens, then the actions. */
export function WalletDialog({
	title,
	body,
	children,
	actions,
}: {
	title: string;
	body?: string | undefined;
	children?: ReactNode;
	actions: ReactNode;
}) {
	return (
		<div className="flex w-full max-w-[26rem] flex-col gap-4 rounded-tile border border-line bg-paper p-5 shadow-[var(--shadow-composer)]">
			<div className="flex flex-col gap-1.5">
				<h2 className="min-w-0 text-heading font-semibold text-ink [overflow-wrap:anywhere]">{title}</h2>
				{body === undefined ? null : <p className="text-ui text-ink-2">{body}</p>}
			</div>
			{children}
			<div className="flex flex-wrap justify-end gap-2">{actions}</div>
		</div>
	);
}

/** A removal the daemon refused (C17), open while there is a `reason`: why, and only Close, as the same act can't help. */
export function RemoveRefused({
	wallet,
	reason,
	onClose,
}: {
	wallet: string;
	reason: string | undefined;
	onClose: () => void;
}) {
	const words = removeBlockedWords(wallet);
	return (
		<AlertDialog open={reason !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle className="[overflow-wrap:anywhere]">{words.title}</AlertDialogTitle>
					<AlertDialogDescription>{words.body}</AlertDialogDescription>
				</AlertDialogHeader>
				<RemoveReasons reasons={reason === undefined ? [] : [reason]} />
				{/* one action fills the footer, not the first of two columns */}
				<AlertDialogFooter className="group-data-[size=sm]/alert-dialog-content:grid-cols-1">
					<AlertDialogCancel>Close</AlertDialogCancel>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

// ── Making a wallet, and saving its key ─────────────────────────────────────────────────────────────────────────────

export type CreateState = "form" | "creating" | "waiting" | "unsynced" | "failed" | "refused" | "no_keychain";

/**
 * Why the signer refused a creation before it kept anything (`CreateState` "refused"), in the owner's words: the
 * reason's own, since nothing was made yet. Another home holding the lease is said on its own (`CreateWallet`).
 */
const CREATE_REFUSED: { readonly [reason in OfflineReason]?: string } = {
	locked: "Your keychain is locked. Unlock it, then try again.",
	denied: "Your keychain asked whether banda may use it, and the answer was no. Try again and choose Always allow.",
	timeout: "Your keychain didn't answer in time, perhaps behind a prompt you haven't seen. Answer it, then try again.",
	ambiguous: "Your keychain holds more than one item where the key was to go. Try again.",
	debugging:
		"banda runs with a debugger or heap-dump flag (such as --inspect), which could read a key from its memory, so it makes none until banda runs without it.",
	keychain: "banda couldn't use your keychain. Try again; if it keeps failing, restart banda.",
};

/** A network a wallet can be made on, as the owner picks it. */
export type NetworkChoice = { readonly id: string; readonly label: string; readonly testnet: boolean };

const NETWORKS: readonly NetworkChoice[] = [
	{ id: "base", label: "Base", testnet: false },
	{ id: "base-sepolia", label: "Base Sepolia", testnet: true },
];

/**
 * A new wallet: a name and a network (fixed for good), and, made from an agent's settings, that agent already chosen.
 * banda makes the key on this computer and keeps it in the keychain; while the keychain does not answer, the wallet
 * waits, and it is made the moment it does. A wallet whose key could not be kept is never shown.
 */
/**
 * A step's field in a form of its own, so Enter in it does what the step's primary button does, when that button may
 * (as RpcForm's field does): `onSubmit` is given only then. It lays out as if it were not there.
 */
function FieldForm({ onSubmit, children }: { onSubmit?: (() => void) | undefined; children: ReactNode }) {
	return (
		<form
			className="contents"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit?.();
			}}
		>
			{children}
		</form>
	);
}

export function CreateWallet({
	state = "form",
	name = "",
	network,
	networks = NETWORKS,
	forAgent,
	forAgentOn = true,
	taken = false,
	phone = false,
	parent = DEFAULT_PARENT,
	inBrowser = false,
	reason,
	onName,
	onNetwork,
	onForAgent,
	onCreate,
	onMove,
	onCancel,
}: {
	state?: CreateState;
	/** Why the signer refused the creation, with `state` "refused": another home holds the lease, or the keychain. */
	reason?: OfflineReason | undefined;
	name?: string;
	/** The id of the network picked; the first offered when absent. */
	network?: string | undefined;
	networks?: readonly NetworkChoice[];
	forAgent?: Who | undefined;
	/**
	 * Whether `forAgent` is to read it, as the checkbox says: switched on as the owner leaves the save step, never as it
	 * is made (UC-01, H-001).
	 */
	forAgentOn?: boolean;
	/** Another wallet already has this name: allowed, and said, since the two are then told apart by address (H-041). */
	taken?: boolean;
	phone?: boolean;
	parent?: WalletParent;
	/**
	 * Made in a browser, not the desktop app, where the key is shown next: an extension there can read it (H-272), so
	 * the page names the safer ways before the owner makes one.
	 */
	inBrowser?: boolean;
	onName?: (name: string) => void;
	onNetwork?: (network: string) => void;
	onForAgent?: (on: boolean) => void;
	onCreate?: () => void;
	/** Moves signing to this home, where the desktop app can (UC-21); absent elsewhere. */
	onMove?: (() => void) | undefined;
	onCancel?: () => void;
}) {
	const busy = state === "creating" || state === "waiting";
	/**
	 * Once the daemon said a record exists for this request (waiting on the keychain, or made but not yet synced), the
	 * name and network are the ones it holds: a retry only finishes that creation, never asks it for others (C14, OD-9).
	 */
	const fixed = busy || state === "unsynced";
	const elsewhere = reason === "other_home";
	const picked = network ?? networks[0]?.id;
	const choice = useId();
	const creatable = !(busy || state === "no_keychain" || (state === "refused" && elsewhere) || name.trim() === "");
	return (
		<SettingsPage
			title="New wallet"
			icon={WalletIcon}
			parent={{ title: parent.title, href: parent.href }}
			phone={phone}
			{...(parent.onBack === undefined ? {} : { onBack: parent.onBack })}
			footer={
				<>
					<Button disabled={!creatable} onClick={onCreate}>
						{busy ? <Spinner className="size-3.5" /> : null}
						{busy ? "Making the wallet" : "Make wallet"}
					</Button>
					<Button variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
				</>
			}
		>
			{state === "waiting" ? <OfflineNotice reason="creating" onAction={onCreate} /> : null}
			{state === "unsynced" ? (
				<WalletNotice
					icon={HourglassIcon}
					title="The wallet is almost made"
					body="banda made it, but couldn't yet save that safely to disk. Try again to finish, and to see its key."
					action="Try again"
					{...(onCreate === undefined ? {} : { onAction: onCreate })}
				/>
			) : null}
			{state === "failed" ? (
				<WalletNotice
					icon={TriangleAlertIcon}
					tone="danger"
					title="The wallet wasn't made"
					body="banda couldn't keep this wallet's key in your keychain, so nothing was made. Try again."
					action="Try again"
					{...(onCreate === undefined ? {} : { onAction: onCreate })}
				/>
			) : null}
			{state === "refused" && elsewhere ? (
				<WalletNotice
					icon={ServerIcon}
					title="Another home signs for this home's wallets"
					body={`This home is a copy (a backup, a fork or a new computer), so it makes no wallet: nothing was made. Move signing here to make wallets here; the other home then stops signing for them.${onMove === undefined ? ` ${OFFLINE.other_home.elsewhere}` : ""}`}
					{...(onMove === undefined ? {} : { action: OFFLINE.other_home.action, onAction: onMove })}
				/>
			) : null}
			{state === "refused" && !elsewhere ? (
				<WalletNotice
					icon={TriangleAlertIcon}
					tone="danger"
					title="The wallet wasn't made"
					body={(reason === undefined ? undefined : CREATE_REFUSED[reason]) ?? CREATE_REFUSED.keychain ?? ""}
					action="Try again"
					{...(onCreate === undefined ? {} : { onAction: onCreate })}
				/>
			) : null}
			{state === "no_keychain" ? (
				<WalletNotice
					icon={KeyRoundIcon}
					title="This computer has no keychain banda can use"
					body="banda keeps a wallet's key in your system's keychain, never in a file. Run banda in a desktop session to make one."
				/>
			) : null}
			<FieldForm {...(creatable && onCreate !== undefined ? { onSubmit: onCreate } : {})}>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
				<label className="flex flex-col gap-1.5">
					<span className="text-ui font-medium text-ink">Name</span>
					<Input
						{...(onName === undefined
							? { defaultValue: name }
							: { value: name, onChange: (event) => onName(event.target.value) })}
						placeholder="Travel, API credits…"
						disabled={fixed}
						maxLength={NAME_MAX}
						className="text-heading"
					/>
					{taken ? (
						<span className="min-w-0 text-meta text-ink-2 [overflow-wrap:anywhere]">
							You already have a wallet named {name.trim()}. Both keep the name; their addresses tell them apart.
						</span>
					) : null}
				</label>
			</FieldForm>
			<Block title="Network" note="A wallet stays on the network it's made on.">
				{/* a row per network, its whole row the radio's label: the group gives the arrow keys and the focus */}
				<RadioGroup
					aria-label="Network"
					{...(picked === undefined ? {} : { value: picked })}
					onValueChange={(next) => onNetwork?.(next)}
					disabled={fixed}
					className="flex flex-col gap-0 divide-y divide-line-soft overflow-hidden rounded-tile border border-line-soft"
				>
					{networks.map((one) => (
						<label
							key={one.id}
							htmlFor={`${choice}-${one.id}`}
							data-choice={one.id}
							className="flex min-h-12 w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left has-disabled:cursor-default"
						>
							<RadioGroupItem
								id={`${choice}-${one.id}`}
								value={one.id}
								className="border-line bg-transparent data-checked:border-ink data-checked:bg-transparent [&_[data-slot=radio-group-indicator]>span]:bg-ink"
							/>
							<span className="flex flex-1 flex-col">
								<span className="text-ui text-ink">{one.label}</span>
								<span className="text-meta text-ink-2">
									{one.testnet ? "A test network: its money is worth nothing." : "Real money: ETH and USDC, low fees."}
								</span>
							</span>
						</label>
					))}
				</RadioGroup>
			</Block>
			{forAgent === undefined ? null : (
				<Rows>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control */}
					<label className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
						<Face face={forAgent.face} name={forAgent.name} size="message" />
						<span className="flex flex-1 flex-col">
							<span className="text-ui text-ink">{forAgent.name} may read it</span>
							<span className="text-meta text-ink-2">Its address and balance, once you're done with its key.</span>
						</span>
						<Checkbox
							checked={forAgentOn}
							disabled={busy}
							onCheckedChange={(checked) => onForAgent?.(checked === true)}
						/>
					</label>
				</Rows>
			)}
			<p className="flex items-start gap-2 text-meta text-ink-2">
				<KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
				banda makes the wallet's key on this computer and keeps it in your keychain. No one else holds it, banda's
				servers included: next, you save a copy.
			</p>
			{inBrowser ? (
				<p data-in-browser="" className="flex items-start gap-2 text-meta text-ink-2">
					<TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
					<span>
						An extension in this browser can read the key shown next. banda's desktop app, or{" "}
						<span className="font-code">banda wallet create</span> in a terminal, is safer.
					</span>
				</p>
			) : null}
			<p className="text-meta text-ink-2">{ANY_PROGRAM}</p>
		</SettingsPage>
	);
}

export type SaveKeyStep =
	| "intro"
	| "shown"
	| "copied"
	| "check"
	| "wrong"
	| "saved"
	| "closed"
	| "app_only"
	| "refused"
	| "confirm_host"
	| "elsewhere";

/** A key's 64 characters, hidden: what the box shows before the key is, or where there is none to show. */
const HIDDEN_KEY = `0x${"•".repeat(64)}`;

/**
 * The key, as it is shown once: `0x` and 64 characters, in groups of four, beside the address it opens, which a screen
 * reader reads group by group. Hidden, or with no key given, it is blurred dots, which a screen reader announces as
 * "private key, hidden" and never reads (H-281).
 */
function KeyBox({ secret, hidden = false }: { secret?: string | undefined; hidden?: boolean }) {
	const shown = !hidden && secret !== undefined;
	return (
		<div className="flex flex-col gap-2 rounded-field bg-paper-2 px-3.5 py-3">
			<span className="text-meta text-ink-2">
				Private key{shown ? null : <span className="sr-only">, hidden</span>}
			</span>
			{/* groups of four drawn apart by a gap, not by spaces: a copy selected by hand is the key as wallet apps
			    take it, `0x` and 64 hex digits, and a copy event writes exactly that whatever the selection held */}
			<span
				aria-hidden={shown ? undefined : true}
				data-key={shown ? "" : undefined}
				onCopy={(event) => {
					if (!shown || secret === undefined) return;
					event.preventDefault();
					event.clipboardData.setData("text/plain", secret);
				}}
				className={cn(
					"flex flex-wrap gap-x-[1ch] font-code text-body leading-relaxed text-ink",
					shown ? "select-all" : "blur-sm select-none",
				)}
			>
				{keyGroups(shown ? secret : HIDDEN_KEY).map((group, at) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a group's place is what it is
					<span key={at}>{group}</span>
				))}
			</span>
		</div>
	);
}

/** The steps whose page takes the focus as it opens (SaveKey's `target`). */
const FOCUSED: ReadonlySet<SaveKeyStep> = new Set<SaveKeyStep>(["shown", "copied", "check", "saved"]);

/**
 * Saving the key, right after the wallet is made: why it matters, the key shown once on this computer, copied (the
 * clipboard clears itself), then pasted back to check the copy. Skipped, the wallet says "Not backed up" until it is
 * saved; Receive waits until this step ends. Later, only banda's desktop app on this computer shows it again, after the
 * computer confirms it's the owner.
 */
export function SaveKey({
	step,
	wallet,
	secret,
	hidden = false,
	phone = false,
	parent,
	clears,
	clearsWithPage = false,
	inBrowser = false,
	laterKey = "unknown",
	pasted,
	spaced = false,
	busy = false,
	onShow,
	onSkip,
	onCopy,
	onSaved,
	onPaste,
	onCheck,
	onShowAgain,
	onReceive,
	onDone,
	onConfirm,
	onCheckCopy,
}: {
	step: SaveKeyStep;
	wallet: ShownWallet;
	/** The key, once revealed: held by this page alone while it shows it, and never kept. */
	secret?: string | undefined;
	/** Shown, then hidden again after 30 s (H-270); Show key shows it again. */
	hidden?: boolean;
	phone?: boolean;
	parent?: WalletParent;
	/** How long until the clipboard clears itself: "0:52". */
	clears?: string | undefined;
	/** Whether the clear needs this page open: in a browser, closing it leaves the key on the clipboard. */
	clearsWithPage?: boolean;
	/** In a browser, not the desktop app: its extensions can read the key this page shows (H-272). */
	inBrowser?: boolean;
	/**
	 * Where the key is shown again after this step, as this screen can tell (OD-2, H-266): every step words it so, and
	 * none promises a later showing a computer that cannot ask who you are refuses.
	 */
	laterKey?: LaterKey;
	/** The copy pasted back, as typed. */
	pasted?: string;
	/** The copy checked had spaces, which the check left out: said once it is backed up. */
	spaced?: boolean;
	busy?: boolean;
	onShow?: () => void;
	onSkip?: () => void;
	onCopy?: () => void;
	/** "I saved it": on to the check. */
	onSaved?: () => void;
	onPaste?: (text: string) => void;
	onCheck?: () => void;
	onShowAgain?: () => void;
	onReceive?: () => void;
	onDone?: () => void;
	/** Confirm it's you: the computer's own prompt, then the key in a window of its own. */
	onConfirm?: () => void;
	/** On to pasting a copy the owner already holds back, to check it: no key is shown for it. */
	onCheckCopy?: () => void;
}) {
	const unsaved = wallet.backup === "unsaved";
	/** Where the key is seen again, said by every step that cannot show it here. */
	const again =
		laterKey === "here"
			? "See it again from the wallet's settings in banda's desktop app, after your computer confirms it's you."
			: laterKey === "never"
				? "This computer can't confirm it's you, so banda can't show it again here."
				: "Later, only banda's desktop app on a Mac with Touch ID shows it again, after you confirm it's you; any other computer never shows it again.";
	/**
	 * What every step that cannot show the key here still offers: checking a copy the owner holds already (`banda wallet
	 * create`'s, or one saved before), skipping the step while the wallet is not backed up yet, and leaving.
	 */
	/** Said only where the step offers Check your copy: a key saved already has no copy left to check here. */
	const checkHere =
		wallet.backup !== "saved" && onCheckCopy !== undefined ? " If you hold a copy already, check it here." : "";
	const later = (leave: string, checks = true) => (
		<>
			{checks && wallet.backup !== "saved" && onCheckCopy !== undefined ? (
				<Button variant="outline" onClick={onCheckCopy}>
					Check your copy
				</Button>
			) : null}
			{unsaved && onSkip !== undefined ? (
				<Button variant="ghost" disabled={busy} onClick={onSkip}>
					Skip for now
				</Button>
			) : null}
			<Button variant="ghost" onClick={onDone}>
				{leave}
			</Button>
		</>
	);
	const opens = (
		<p className="flex flex-wrap items-center gap-x-1.5 text-ui text-ink-2">
			<span>
				Opens <span className="font-code text-ink">{shortAddress(wallet.address)}</span> on {wallet.network}.
			</span>
			{wallet.testnet === true ? <TestnetMark /> : null}
		</p>
	);
	const back = parent ?? { title: wallet.name, href: "#" };
	const page = (children: ReactNode, footer?: ReactNode) => (
		<SettingsPage
			title="Save your key"
			icon={KeyRoundIcon}
			parent={{ title: back.title, href: back.href }}
			phone={phone}
			footer={footer}
			{...(back.onBack === undefined ? {} : { onBack: back.onBack })}
		>
			{children}
		</SettingsPage>
	);
	/** No key held by this page to show again: a copy checked later, which only the owner's own copy can answer. */
	const keyless = secret === undefined && onPaste !== undefined;
	/**
	 * Each step takes the place of the control pressed: the focus goes to what the new step is for (the key's button,
	 * the copy's field, the backed-up heading), never to the page. Only on a live page: a specimen takes no focus.
	 */
	const target = useRef<HTMLElement | null>(null);
	const live = onSaved !== undefined || onPaste !== undefined || onShow !== undefined;
	useEffect(() => {
		if (live && FOCUSED.has(step)) target.current?.focus();
	}, [live, step]);
	const checkable = !busy && (onPaste === undefined || (pasted ?? "").trim() !== "");
	switch (step) {
		case "intro":
			return page(
				<>
					<section className="flex flex-col gap-2">
						<h2 className="min-w-0 text-heading font-semibold text-ink [overflow-wrap:anywhere]">
							Save {wallet.name}'s key
						</h2>
						<p className="text-body text-ink-2">
							The key is the wallet. Anyone who has it can spend everything in it, and banda can't give it back if this
							computer is lost. Keep a copy where only you can open it, such as your password manager.
						</p>
						{laterKey === "here" ? null : (
							<p className="text-ui text-ink-2" data-only-now="">
								{laterKey === "never"
									? "This computer can't confirm it's you, so this is the only time banda shows this key."
									: "Only banda's desktop app on a Mac with Touch ID shows it again later: on any other computer, this is the only time."}
							</p>
						)}
						{inBrowser ? (
							<p className="text-ui text-ink-2" data-in-browser="">
								This browser's extensions can read what this page shows. To see a key where none run, make wallets in
								banda's desktop app, or with <span className="font-code">banda wallet create</span> in a terminal.
							</p>
						) : null}
					</section>
					<KeyBox hidden />
				</>,
				<>
					<Button disabled={busy} onClick={onShow}>
						{busy ? <Spinner className="size-3.5" /> : null}
						Show key
					</Button>
					<Button variant="ghost" disabled={busy} onClick={onSkip}>
						Skip for now
					</Button>
				</>,
			);
		case "shown":
		case "copied":
			return page(
				<>
					<KeyBox secret={secret} hidden={hidden} />
					{opens}
					{secret === undefined ? (
						<p className="text-ui text-ink-2">
							The key left this screen when you switched away from it. If you saved a copy, check it next. {again}
						</p>
					) : (
						<span className="flex flex-wrap items-center gap-2">
							{hidden ? (
								<Button ref={target as Ref<HTMLButtonElement>} variant="outline" onClick={onShow}>
									Show key
								</Button>
							) : (
								<Button ref={target as Ref<HTMLButtonElement>} variant="outline" onClick={onCopy}>
									{step === "copied" ? <CheckIcon className="text-alive" /> : <CopyIcon />}
									{step === "copied" ? "Copied" : "Copy key"}
								</Button>
							)}
							{step === "copied" && clears !== undefined ? (
								<span className="text-meta text-ink-2">
									{clearsWithPage
										? `Your clipboard clears itself in ${clears} if banda stays open.`
										: `Your clipboard clears itself in ${clears}.`}
								</span>
							) : null}
						</span>
					)}
					<p className="text-meta text-ink-2">
						{step === "copied"
							? "A clipboard manager, or a clipboard shared with your other devices, may keep a copy of its own. "
							: ""}
						Wallet apps such as MetaMask open it as a private key (Import account → Private key). There is no seed
						phrase: this key is the whole wallet. Don't send it to anyone, an agent included.
					</p>
					{secret === undefined ? null : (
						<p className="text-meta text-ink-2">
							It hides again after 30 seconds, and leaves this screen when you switch away. A screen reader reads it
							aloud.
						</p>
					)}
				</>,
				<Button onClick={onSaved}>I saved it</Button>,
			);
		case "check":
		case "wrong":
			return page(
				<>
					<section className="flex flex-col gap-2">
						<h2 className="text-heading font-semibold text-ink">Check your copy</h2>
						<p className="text-body text-ink-2">
							Paste the key you saved. banda checks that it opens this wallet, and keeps nothing of it.
						</p>
					</section>
					<FieldForm {...(checkable && onCheck !== undefined ? { onSubmit: onCheck } : {})}>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
						<label className="flex flex-col gap-1.5">
							<span className="text-ui font-medium text-ink">Your saved key</span>
							<Input
								ref={target as Ref<HTMLInputElement>}
								{...(onPaste === undefined
									? {
											defaultValue:
												step === "wrong" ? "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f36231" : "",
										}
									: {
											value: pasted ?? "",
											onChange: (event) => onPaste(event.target.value),
											// a paste is the whole copy: it takes the field's place, never joins what an earlier one left
											onPaste: (event) => {
												event.preventDefault();
												onPaste(event.clipboardData.getData("text/plain"));
											},
										})}
								placeholder="0x…"
								type="password"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={step === "wrong"}
								disabled={busy}
								className="font-code"
							/>
							{step === "wrong" ? (
								<span className="text-meta text-danger">
									{keyless
										? `This doesn't open ${shortAddress(wallet.address)}. Paste the key you saved for this wallet, as you saved it.`
										: `This doesn't open ${shortAddress(wallet.address)}. Copy the key again, then paste it here.`}
								</span>
							) : null}
						</label>
					</FieldForm>
				</>,
				<>
					<Button disabled={!checkable} onClick={onCheck}>
						{busy ? <Spinner className="size-3.5" /> : null}
						Check
					</Button>
					{/* with no key here to show again, the step keeps its ways out: Skip for now while unsaved, and Done */}
					{keyless ? (
						later("Done", false)
					) : (
						<Button variant="ghost" onClick={onShowAgain}>
							Show key again
						</Button>
					)}
				</>,
			);
		case "saved":
			return page(
				<section className="flex flex-col items-start gap-3">
					<span className="flex size-10 items-center justify-center rounded-full bg-paper-3">
						<CheckIcon className="size-5 text-alive" />
					</span>
					<h2
						ref={target as Ref<HTMLHeadingElement>}
						tabIndex={-1}
						className="min-w-0 max-w-full text-heading font-semibold text-ink outline-none [overflow-wrap:anywhere]"
					>
						{wallet.name} is backed up
					</h2>
					<p className="text-body text-ink-2">Your copy opens it. Next, put money in: open Receive for its address.</p>
					{spaced ? (
						<p data-spaced className="text-meta text-ink-2">
							banda checked your copy without its spaces. Keep the key as 0x and 64 characters with no spaces: that's
							how wallet apps take it.
						</p>
					) : null}
				</section>,
				<>
					<Button onClick={onReceive}>Receive</Button>
					<Button variant="ghost" onClick={onDone}>
						Done
					</Button>
				</>,
			);
		case "closed":
			return page(
				<WalletNotice
					icon={ClockIcon}
					title="This window has closed"
					body={`A new wallet's key shows on this screen for 10 minutes. ${again}`}
				/>,
				<Button variant="ghost" onClick={onDone}>
					Done
				</Button>,
			);
		case "refused":
			return page(
				<WalletNotice
					icon={KeyRoundIcon}
					title="The key couldn't be shown here"
					body={`banda didn't show the new wallet's key on this screen. ${again}`}
				/>,
				later("Done"),
			);
		case "app_only":
			return page(
				<WalletNotice
					icon={MonitorIcon}
					title={
						laterKey === "never" ? "The key was shown as the wallet was made" : "See the key in banda's desktop app"
					}
					body={
						laterKey === "never"
							? `This computer can't confirm it's you, so banda shows a wallet's key only right after the wallet is made.${checkHere}`
							: `A browser shows a wallet's key only right after the wallet is made. ${again}${checkHere}`
					}
				/>,
				later("Done"),
			);
		case "confirm_host":
			return page(
				<section className="flex flex-col items-start gap-3">
					<span className="flex size-10 items-center justify-center rounded-full bg-paper-3">
						<FingerprintIcon className="size-5 text-ink-2" />
					</span>
					<h2 className="text-heading font-semibold text-ink">Confirm it's you</h2>
					<p className="text-body text-ink-2">
						Your computer asks for Touch ID before banda shows {wallet.name}'s key. You'll see it in a window of its
						own, for 30 seconds each time you press Show key; it closes when you switch away.
					</p>
				</section>,
				<>
					<Button disabled={busy} onClick={onConfirm}>
						{busy ? <Spinner className="size-3.5" /> : null}
						Confirm
					</Button>
					{later("Cancel")}
				</>,
			);
		case "elsewhere":
			return page(
				<WalletNotice
					icon={MonitorIcon}
					title="Open banda's desktop app to see the key"
					body="A wallet's key shows only on the computer banda runs on, in banda's desktop app, never on a phone or another device. Check your copy there too."
				/>,
				later("Done", false),
			);
	}
}

// ── Receive and Send ────────────────────────────────────────────────────────────────────────────────────────────────

/** `mismatch`: the daemon's answer named another address than the wallet's record, so none is shown (H-261). */
export type ReceiveState = "ready" | "save_first" | "code" | "unchecked" | "key_unchecked" | "unopenable" | "mismatch";

/** A wallet that is not in this home: removed, or a link from another home. */
export function NoWallet({
	phone = false,
	parent,
	onWallets,
}: {
	phone?: boolean;
	parent?: WalletParent;
	onWallets?: () => void;
}) {
	const back = parent ?? DEFAULT_PARENT;
	return (
		<SettingsPage
			title="Wallet"
			icon={WalletIcon}
			parent={{ title: back.title, href: back.href }}
			phone={phone}
			{...(back.onBack === undefined ? {} : { onBack: back.onBack })}
		>
			<p className="text-ui text-ink-2">
				This wallet isn't in this home: it was removed, or the link is another home's.
			</p>
			<Button variant="outline" size="sm" className="self-start" onClick={onWallets}>
				Your wallets
			</Button>
		</SettingsPage>
	);
}

/**
 * The page a wallet's link opens when it names more than one of the home's wallets (their addresses share their ends):
 * each by its name and more of its address, to choose from.
 */
export function WhichWallet({
	wallets,
	phone = false,
	parent,
	onChoose,
}: {
	wallets: readonly {
		readonly name: string;
		readonly address: string;
		/** The network's label. */
		readonly network: string;
		/** On a test network: the row carries the Testnet mark (H-040). */
		readonly testnet?: boolean;
	}[];
	phone?: boolean;
	parent?: WalletParent;
	onChoose?: (address: string) => void;
}) {
	const back = parent ?? DEFAULT_PARENT;
	return (
		<SettingsPage
			title="Wallet"
			icon={WalletIcon}
			parent={{ title: back.title, href: back.href }}
			phone={phone}
			{...(back.onBack === undefined ? {} : { onBack: back.onBack })}
		>
			<p className="text-ui text-ink-2">This link names more than one of your wallets. Which one?</p>
			<ul className="flex flex-col gap-2" data-which-wallet="">
				{wallets.map((wallet) => (
					<li key={wallet.address}>
						<Button
							variant="outline"
							className="h-auto w-full min-w-0 justify-start gap-3 py-2 text-left"
							onClick={() => onChoose?.(wallet.address)}
						>
							<WalletMark />
							{/* as a wallet's row: the name, the short address, then the network on its own line, never cut (H-039) */}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-ui text-ink [overflow-wrap:anywhere] whitespace-normal">{wallet.name}</span>
								<span className="font-code text-meta text-ink-2 whitespace-normal">
									{wallet.address.slice(0, 10)}…{wallet.address.slice(-8)}
								</span>
								<span className="flex min-w-0 flex-wrap items-center gap-1.5 whitespace-normal text-meta text-ink-2">
									<span>on {wallet.network}</span>
									{wallet.testnet === true ? <TestnetMark /> : null}
								</span>
							</span>
						</Button>
					</li>
				))}
			</ul>
		</SettingsPage>
	);
}

/**
 * What Receive says once the owner acknowledged the code at the address: what the acknowledgement records, and that
 * nothing it hides comes back while the code is there. It promises nothing this build does not do.
 */
export const RECEIVE_ACKNOWLEDGED =
	"You acknowledged this code, and banda keeps that you know why it runs. Its address stays hidden here, and agents can't use the wallet, while the code is there.";

/**
 * Receive: the address, whole and in groups, its QR and Copy, and the network it is on, said plainly, since money sent
 * on another network does not arrive here. Withheld until the key is saved or skipped; a wallet whose saving was
 * skipped says it has no saved copy and offers to save one, since funds are invited in here (H-005). Replaced by a
 * warning when the address has code.
 */
export function Receive({
	wallet,
	state = "ready",
	phone = false,
	parent,
	copied = false,
	acknowledged = false,
	onCopy,
	onSaveKey,
	onRetry,
	onAcknowledge,
	onUnarchive,
}: {
	wallet: ShownWallet;
	/**
	 * `checking` while banda asks whether the address may be given out yet; the wallet's own state when it is not ready,
	 * which gives out no address and is not asked.
	 */
	state?: ReceiveState | "checking" | "archived" | "removing" | "creating";
	phone?: boolean;
	parent?: WalletParent;
	copied?: boolean;
	/** The owner acknowledged the code at the address: banda keeps that they did, and the warning stays. */
	acknowledged?: boolean;
	onCopy?: () => void;
	onSaveKey?: () => void;
	/** Ask again whether code runs at the address, after it could not be checked. */
	onRetry?: () => void;
	/** Acknowledge the code at the address: on the computer banda runs on alone. */
	onAcknowledge?: (() => void) | undefined;
	/** Unarchive an archived wallet, from its notice in the address's place. */
	onUnarchive?: () => void;
}) {
	const back = parent ?? { title: wallet.name, href: "#" };
	return (
		<SettingsPage
			title="Receive"
			icon={ArrowDownLeftIcon}
			parent={{ title: back.title, href: back.href }}
			phone={phone}
			{...(back.onBack === undefined ? {} : { onBack: back.onBack })}
		>
			{state === "checking" ? (
				<p className="text-ui text-ink-2">Checking the address…</p>
			) : state === "archived" ? (
				<ArchivedNotice {...(onUnarchive === undefined ? {} : { onUnarchive })} />
			) : state === "removing" ? (
				<RemovingNotice />
			) : state === "creating" ? (
				<WalletNotice
					icon={HourglassIcon}
					title="Not made yet"
					body="banda gives out the address once the wallet is made and your keychain holds its key."
				/>
			) : state === "code" ? (
				<>
					<OfflineNotice reason="code" />
					{acknowledged ? (
						<p className="text-meta text-ink-2">{RECEIVE_ACKNOWLEDGED}</p>
					) : onAcknowledge === undefined ? null : (
						<Button variant="outline" size="sm" className="self-start" onClick={onAcknowledge}>
							I know why it runs code
						</Button>
					)}
				</>
			) : state === "unchecked" ? (
				<WalletNotice
					icon={TriangleAlertIcon}
					title="The address couldn't be checked"
					body="banda checks that no code runs at the address before showing it, and the network didn't answer. Its address shows once it does."
					action="Try again"
					{...(onRetry === undefined ? {} : { onAction: onRetry })}
				/>
			) : state === "mismatch" ? (
				<WalletNotice
					icon={ShieldAlertIcon}
					title="The address didn't match"
					body="banda answered an address that isn't this wallet's, so none is shown or copied. Don't pay into an address you got anywhere else."
					tone="danger"
					action="Try again"
					{...(onRetry === undefined ? {} : { onAction: onRetry })}
				/>
			) : state === "key_unchecked" ? (
				<WalletNotice
					icon={LockIcon}
					title="The key couldn't be checked"
					body="This wallet's key was never saved, so banda checks that your keychain still opens it before showing its address, and your keychain didn't answer. Its address shows once it does."
					action="Try again"
					{...(onRetry === undefined ? {} : { onAction: onRetry })}
				/>
			) : state === "unopenable" ? (
				<WalletNotice
					icon={ShieldAlertIcon}
					title="Don't send anything to this wallet"
					body="No key on this computer opens it any more, and no copy of its key was saved: anything sent to its address could never be spent, so banda doesn't show it."
					tone="danger"
				/>
			) : state === "save_first" ? (
				<WalletNotice
					icon={KeyRoundIcon}
					title="Save the key first"
					body="Before you put money in, save a copy of the key, or choose to skip it."
					action="Save your key"
					{...(onSaveKey === undefined ? {} : { onAction: onSaveKey })}
				/>
			) : (
				<>
					<div className="flex flex-col items-center gap-4">
						<QrCode value={wallet.address} label={`${wallet.name}'s address`} className="size-48" />
						<span className="flex max-w-full min-w-0 items-center gap-1.5 text-meta text-ink-2">
							<span className="min-w-0 truncate" title={`${wallet.name} on ${wallet.network}`}>
								{wallet.name} on {wallet.network}
							</span>
							{wallet.testnet === true ? <TestnetMark /> : null}
						</span>
						<span
							data-address=""
							className="text-center font-code text-body leading-relaxed text-ink [overflow-wrap:anywhere]"
						>
							{grouped(wallet.address)}
						</span>
						<Button variant="outline" onClick={onCopy}>
							{copied ? <CheckIcon className="text-alive" /> : <CopyIcon />}
							{copied ? "Copied" : "Copy address"}
						</Button>
					</div>
					<WalletNotice
						icon={GlobeIcon}
						title={`On ${wallet.network} only`}
						body={`Send ${wallet.usdc === undefined ? "ETH" : "ETH or USDC"} on ${wallet.network}.${wallet.testnet === true ? " It's a test network: what's sent here is worth nothing." : ""} Money sent on another network doesn't arrive here${wallet.backup === "saved" ? "; only the key you saved can get it back." : "."}`}
					/>
					{wallet.backup === "saved" ? null : (
						<WalletNotice
							icon={KeyRoundIcon}
							title="Not backed up"
							body="There's no saved copy of this wallet's key yet: if this computer is lost, so is what you send here."
							action="Save your key"
							{...(onSaveKey === undefined ? {} : { onAction: onSaveKey })}
						/>
					)}
				</>
			)}
		</SettingsPage>
	);
}

export type SendStep = "form" | "review" | "sending";

/**
 * Send, the owner's own: to an address or a recipient, an amount in USDC or ETH, then a review with the whole address,
 * the network and the fee. It joins the wallet's line behind any agent payment already there. Typed errors say what
 * to fix beside the field; a new address sent from a phone waits for the computer.
 */
export function Send({
	wallet,
	step = "form",
	to = "",
	amount = "",
	token = "USDC",
	toError,
	amountError,
	review,
	phone = false,
	fromPhone = false,
}: {
	wallet: ShownWallet;
	step?: SendStep;
	to?: string;
	amount?: string;
	token?: Token;
	toError?: string | undefined;
	amountError?: string | undefined;
	review?:
		| {
				name?: string | undefined;
				address: string;
				fee: string;
				newAddress?: boolean;
				deniedForAgents?: boolean;
				code?: boolean;
		  }
		| undefined;
	phone?: boolean;
	/** On a paired phone: a new address waits for the computer to confirm (OD-3). */
	fromPhone?: boolean;
}) {
	if (step === "form")
		return (
			<SettingsPage
				title={`Send from ${wallet.name}`}
				icon={ArrowUpRightIcon}
				parent={{ title: wallet.name, href: "#" }}
				phone={phone}
				footer={
					<Button disabled={to === "" || amount === "" || toError !== undefined || amountError !== undefined}>
						Review
					</Button>
				}
			>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
				<label className="flex flex-col gap-1.5">
					<span className="text-ui font-medium text-ink">To</span>
					<Input
						defaultValue={to}
						placeholder="A name, or a 0x address"
						aria-invalid={toError !== undefined}
						className="font-code placeholder:font-sans"
					/>
					{toError === undefined ? null : <span className="text-meta text-danger">{toError}</span>}
					<span className="flex flex-wrap gap-1.5">
						{["Ana", "Bike shop", "Weather API"].map((one) => (
							<Button key={one} variant="outline" size="xs" className="rounded-chip">
								{one}
							</Button>
						))}
					</span>
				</label>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
				<label className="flex flex-col gap-1.5">
					<span className="text-ui font-medium text-ink">Amount</span>
					<span className="flex gap-2">
						<Input
							defaultValue={amount}
							inputMode="decimal"
							placeholder="0.00"
							aria-invalid={amountError !== undefined}
							className="flex-1 text-heading tabular-nums"
						/>
						<Segmented
							label="Token"
							value={token}
							options={[
								{ value: "USDC", label: "USDC" },
								{ value: "ETH", label: "ETH" },
							]}
						/>
					</span>
					{amountError === undefined ? null : <span className="text-meta text-danger">{amountError}</span>}
					<span className="flex items-center gap-2 text-meta text-ink-2">
						{token === "USDC"
							? `${wallet.usdc ?? "?"} USDC available`
							: `${wallet.eth ?? "?"} ETH available, keeping a little for fees`}
						<Button variant="link" size="xs" className="text-meta">
							Send all
						</Button>
					</span>
				</label>
			</SettingsPage>
		);
	const shown = review ?? { address: to, fee: "≈ 0.000004 ETH" };
	return (
		<SettingsPage
			title="Review"
			icon={ArrowUpRightIcon}
			parent={{ title: wallet.name, href: "#" }}
			phone={phone}
			footer={
				<>
					<Button disabled={step === "sending"}>
						{step === "sending" ? <Spinner className="size-3.5" /> : null}
						{step === "sending"
							? "Sending"
							: fromPhone && shown.newAddress === true
								? "Ask my computer"
								: `Send ${amount} ${token}`}
					</Button>
					<Button variant="ghost" disabled={step === "sending"}>
						Back
					</Button>
				</>
			}
		>
			<section className="flex flex-col gap-1">
				<span className="text-meta text-ink-2">You send</span>
				<span className="text-display font-semibold text-ink tabular-nums">
					{amount} <span className="text-heading font-medium text-ink-2">{token}</span>
				</span>
			</section>
			{shown.code === true ? <OfflineNotice reason="code" /> : null}
			{shown.newAddress === true ? (
				<WalletNotice
					icon={TriangleAlertIcon}
					title={fromPhone ? "Your computer confirms new addresses" : "First payment to this address"}
					body={
						fromPhone
							? "Sending to an address this wallet hasn't paid before waits for banda on your computer. It's held there for 24 hours."
							: "Check every character with whoever gave it to you. A payment can't be taken back."
					}
				/>
			) : null}
			{shown.deniedForAgents === true ? (
				<WalletNotice
					icon={CircleSlashIcon}
					title={`Agents don't pay ${shown.name ?? "this recipient"}`}
					body="It's set to Deny. You can send to it yourself; that doesn't change the rule."
				/>
			) : null}
			<Rows>
				<Fact label="To">
					{shown.name === undefined ? null : <span className="block font-medium">{shown.name}</span>}
					<span className="block font-code text-meta">{grouped(shown.address)}</span>
				</Fact>
				<Fact label="Network">{wallet.network}</Fact>
				<Fact label="Network fee">{shown.fee}</Fact>
				<Fact label="From">
					{wallet.name} · <span className="font-code">{shortAddress(wallet.address)}</span>
				</Fact>
			</Rows>
			{shown.code === true ? (
				// biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
				<label className="flex items-start gap-2.5 text-ui text-ink">
					<Checkbox className="mt-0.5" />I know this wallet's address runs code, and I still want to send.
				</label>
			) : null}
		</SettingsPage>
	);
}

// ── Getting a wallet back online ────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a Restore is: the form, a key that does not open the wallet, a copy that is no key's text, the wallet back online, or (outside banda's
 * desktop app, which alone takes a key to the keychain without the daemon seeing it) where to do it.
 */
export type RestoreState = "form" | "wrong" | "not_a_key" | "restored" | "elsewhere";

/** Restore key: the copy the owner saved, pasted back; it must open the wallet's address, or nothing changes. */
export function RestoreKey({
	wallet,
	state = "form",
	phone = false,
	parent,
	pasted,
	busy = false,
	onPaste,
	onRestore,
	onDone,
}: {
	wallet: ShownWallet;
	state?: RestoreState;
	phone?: boolean;
	parent?: WalletParent;
	/** The key pasted, as typed: held by this page alone until it is sent to the desktop app, and never kept. */
	pasted?: string;
	busy?: boolean;
	onPaste?: (text: string) => void;
	onRestore?: () => void;
	onDone?: () => void;
}) {
	const page = (body: ReactNode, footer: ReactNode) => (
		<SettingsPage
			title="Restore key"
			icon={KeyRoundIcon}
			parent={parent === undefined ? { title: wallet.name, href: "#" } : { title: parent.title, href: parent.href }}
			phone={phone}
			{...(parent?.onBack === undefined ? {} : { onBack: parent.onBack })}
			footer={footer}
		>
			{body}
		</SettingsPage>
	);
	const restorable = !busy && (onPaste === undefined || (pasted ?? "").trim() !== "");
	const done = (label: string) => (
		<Button variant={state === "restored" ? "default" : "ghost"} onClick={onDone}>
			{label}
		</Button>
	);
	switch (state) {
		case "restored":
			return page(
				<section className="flex flex-col items-start gap-3">
					<span className="flex size-10 items-center justify-center rounded-full bg-paper-3">
						<CheckIcon className="size-5 text-alive" />
					</span>
					<h2 className="min-w-0 max-w-full text-heading font-semibold text-ink [overflow-wrap:anywhere]">
						{wallet.name} is back online
					</h2>
					<p className="text-body text-ink-2">The key is in your keychain again, and banda signs with it.</p>
				</section>,
				done("Done"),
			);
		case "elsewhere":
			return page(
				<WalletNotice
					icon={MonitorIcon}
					title="Restore the key in banda's desktop app"
					body="A wallet's key goes back into your keychain only from banda's desktop app, on the computer banda runs on, after your computer confirms it's you. A browser or a phone never takes a key."
				/>,
				done("Done"),
			);
		default:
			return page(
				<>
					<p className="text-body text-ink-2">
						Paste the key you saved for {wallet.name}. It must open{" "}
						<span className="font-code text-ink">{shortAddress(wallet.address)}</span>, or nothing changes. Your
						computer asks it's you before banda keeps it.
					</p>
					<FieldForm {...(restorable && onRestore !== undefined ? { onSubmit: onRestore } : {})}>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
						<label className="flex flex-col gap-1.5">
							<span className="text-ui font-medium text-ink">Your saved key</span>
							<Input
								{...(onPaste === undefined
									? { readOnly: true, defaultValue: "" }
									: {
											value: pasted ?? "",
											onChange: (event) => onPaste(event.target.value),
											// a paste is the whole copy: it takes the field's place, never joins what an earlier one left
											onPaste: (event) => {
												event.preventDefault();
												onPaste(event.clipboardData.getData("text/plain"));
											},
										})}
								placeholder="0x…"
								type="password"
								autoComplete="off"
								spellCheck={false}
								aria-invalid={state === "wrong" || state === "not_a_key"}
								disabled={busy}
								className="font-code"
							/>
							{state === "wrong" ? (
								<span className="text-meta text-danger">
									This key doesn't open {shortAddress(wallet.address)}. Nothing changed.
								</span>
							) : state === "not_a_key" ? (
								<span className="text-meta text-danger">{NOT_A_KEY} Nothing changed.</span>
							) : null}
						</label>
					</FieldForm>
				</>,
				<>
					<Button disabled={!restorable} onClick={onRestore}>
						{busy ? <Spinner className="size-3.5" /> : null}
						Restore
					</Button>
					{done("Cancel")}
				</>,
			);
	}
}

/**
 * Move signing here: only one home signs for a wallet. On the computer banda runs on, after banda proves each key, the
 * other home stops paying and this one starts.
 */
export function MoveSigning({ wallets, phone = false }: { wallets: readonly ShownWallet[]; phone?: boolean }) {
	return (
		<SettingsPage
			title="Move signing here"
			icon={ServerIcon}
			parent={{ title: "Wallets", href: "#" }}
			phone={phone}
			footer={
				<>
					<Button>Move signing here</Button>
					<Button variant="ghost">Cancel</Button>
				</>
			}
		>
			<p className="text-body text-ink-2">
				Another banda home signs for these wallets: the one this was copied from. Move signing here only if that home is
				gone or you've stopped it. Afterwards it shows the wallets and never pays.
			</p>
			<Rows>
				{wallets.map((wallet) => (
					<RowOf
						key={wallet.address}
						lead={<WalletMark />}
						title={wallet.name}
						detail={<span className="font-code">{shortAddress(wallet.address)}</span>}
						end={
							<span className="flex items-center gap-1 text-meta text-ink-2">
								<CheckIcon className="size-3 text-alive" />
								Key opens it
							</span>
						}
					/>
				))}
			</Rows>
		</SettingsPage>
	);
}
