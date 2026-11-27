/**
 * Wallets, as the owner sees them (proposal: docs/wallets.md, not wired yet). Settings → Wallets lists every wallet
 * with its balance, its agents and, when it cannot pay, its one offline reason; a wallet opens to its balance, Send and
 * Receive, and its tabs: Activity (every payment in its state, and what came in), Recipients (each one's Always, Ask or
 * Deny), Agents (who may spend from it) and Wallet (its key, its network, archive and remove). Making one, saving its
 * key, sending, receiving and getting it back online are each a page of their own. Every figure is a dated reading,
 * never a fact: a balance the RPC did not answer is unknown, never zero.
 */
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	ArrowDownLeftIcon,
	ArrowLeftRightIcon,
	ArrowUpRightIcon,
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
	LockIcon,
	type LucideIcon,
	MonitorIcon,
	PlusIcon,
	ServerIcon,
	ShieldAlertIcon,
	TerminalIcon,
	TriangleAlertIcon,
	UserRoundIcon,
	WalletIcon,
	XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { QrCode } from "../components/QrCode.tsx";
import { Face } from "./Face.tsx";
import type { Who } from "./Row.tsx";
import { Block, RowOf, Rows, SettingsPage } from "./Settings.tsx";

// ── What a wallet is, to the screen ─────────────────────────────────────────────────────────────────────────────────

export type Network = "Base" | "Base Sepolia";
export type Token = "USDC" | "ETH";

/** Why a wallet cannot pay: one reason from one list (UC-04 E2), the `signing` machine's states and C17's code. */
export type OfflineReason =
	| "creating"
	| "locked"
	| "key_missing"
	| "wrong_key"
	| "other_home"
	| "host_mode"
	| "coding_agent"
	| "code";

/** Whether the owner saved the key: confirmed by pasting it back, skipped, or not asked yet (the `wallet` machine). */
export type Backup = "saved" | "skipped" | "unsaved";

export type WalletView = {
	readonly name: string;
	readonly network: Network;
	/** EIP-55, in full. */
	readonly address: string;
	/** As read; null when the RPC did not answer, which is never shown as zero. */
	readonly usdc: string | null;
	readonly eth: string | null;
	/** The owner's currency, an estimate, dated by `read`. */
	readonly fiat?: string | undefined;
	/** When and where the balance was read: "1 min ago, block 23,145,880". */
	readonly read: string;
	/** The last reading that did answer, when this one did not. */
	readonly last?: string | undefined;
	readonly backup: Backup;
	readonly agents: readonly Who[];
	readonly offline?: OfflineReason | undefined;
	readonly archived?: boolean | undefined;
};

/** An address as it reads in a row: its start and its end. */
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** An address as it is checked by eye: in groups of four, every character shown. */
export const grouped = (address: string) => `0x ${(address.slice(2).match(/.{1,4}/g) ?? []).join(" ")}`;

/** The one list of offline reasons: what happened, what it means, and the one thing to do about it. */
export const OFFLINE: Record<OfflineReason, { icon: LucideIcon; title: string; body: string; action?: string }> = {
	creating: {
		icon: HourglassIcon,
		title: "Waiting for your keychain",
		body: "The wallet is made as soon as your keychain answers. Unlock it, or answer its prompt.",
		action: "Try again",
	},
	locked: {
		icon: LockIcon,
		title: "Keychain locked",
		body: "Unlock your keychain to pay from this wallet. Payments in line wait for it, for up to 24 hours.",
		action: "Try again",
	},
	key_missing: {
		icon: KeyRoundIcon,
		title: "Key missing",
		body: "Your keychain no longer holds this wallet's key. Restore it from the copy you saved.",
		action: "Restore key",
	},
	wrong_key: {
		icon: ShieldAlertIcon,
		title: "Wrong key",
		body: "The key in your keychain doesn't open this wallet's address, so banda won't sign with it.",
		action: "Restore key",
	},
	other_home: {
		icon: ServerIcon,
		title: "Another home signs for this wallet",
		body: "This home is a copy (a backup, a fork or a new computer): it shows the wallet and never pays from it.",
		action: "Move signing here",
	},
	host_mode: {
		icon: TerminalIcon,
		title: "Commands on this computer can read wallet keys",
		body: "Agents run commands on this computer as you, without a box. Wallets stay offline until banda runs with a box again.",
	},
	coding_agent: {
		icon: TerminalIcon,
		title: "A coding agent can read wallet keys",
		body: "A coding agent on this computer runs commands without asking you first, and any command it runs can read a wallet's key. Wallets stay offline while it does: have it ask before each command to bring them back.",
		action: "Coding agent settings",
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

/** An address in a row: its ends, the network, and a copy button. */
export function Address({ address, network, copy = true }: { address: string; network?: Network; copy?: boolean }) {
	return (
		<span className="inline-flex items-center gap-1">
			<span className="font-code">{short(address)}</span>
			{network === undefined ? null : <span>on {network}</span>}
			{copy ? (
				<Button variant="ghost" size="icon-xs" aria-label="Copy the address" className="text-ink-2">
					<CopyIcon />
				</Button>
			) : null}
		</span>
	);
}

/** A balance in a row: USDC first, ETH beneath; unknown when the RPC did not answer. */
function Balance({ wallet }: { wallet: WalletView }) {
	if (wallet.usdc === null || wallet.eth === null) return <span className="text-meta text-ink-2">Balance unknown</span>;
	return (
		<span className="flex flex-col items-end tabular-nums">
			<span className="text-ui text-ink">{wallet.usdc} USDC</span>
			<span className="text-meta text-ink-2">{wallet.eth} ETH</span>
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

export function OfflineNotice({ reason }: { reason: OfflineReason }) {
	const words = OFFLINE[reason];
	return (
		<WalletNotice
			icon={words.icon}
			title={words.title}
			body={words.body}
			action={words.action}
			tone={reason === "code" || reason === "wrong_key" ? "danger" : "quiet"}
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
	readonly network: Network;
	readonly url: string;
	/** banda's default, a public endpoint, said as such; absent from the home's configuration until the owner changes it. */
	readonly byDefault: boolean;
	/** Whether it serves the log queries the incoming list is built from (banda's default does; mainnet.base.org does not). */
	readonly logs: boolean;
};

/** One wallet in the list: its mark, name, network and address; its balance; its agents and its one mark. */
function WalletRow({ wallet, onOpen }: { wallet: WalletView; onOpen?: () => void }) {
	const reason = wallet.offline === undefined ? undefined : OFFLINE[wallet.offline];
	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex min-h-16 w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-paper-2"
		>
			<WalletMark />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-ui font-medium text-ink">{wallet.name}</span>
				<span className="truncate text-meta text-ink-2">
					{wallet.network} · <span className="font-code">{short(wallet.address)}</span>
				</span>
				{reason !== undefined ? (
					<span
						className={cn(
							"flex items-center gap-1 text-meta",
							wallet.offline === "code" || wallet.offline === "wrong_key" ? "text-danger" : "text-ink-2",
						)}
					>
						<reason.icon className="size-3 shrink-0" />
						<span className="truncate">{reason.title}</span>
					</span>
				) : wallet.backup === "saved" ? null : (
					<span className="flex items-center gap-1 text-meta text-ink-2">
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
}: {
	wallets: readonly WalletView[];
	archived?: readonly WalletView[];
	rpc: readonly RpcView[];
	/** `none`: no keychain this process can reach (headless Linux, UC-20). */
	keychain?: "ready" | "none";
	hostMode?: boolean;
	onCreate?: () => void;
}) {
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
				note="Money your agents can spend. What you put in a wallet is the most they can spend from it."
			>
				{keychain === "none" ? (
					<WalletNotice
						icon={KeyRoundIcon}
						title="This computer has no keychain banda can use"
						body="banda keeps each wallet's key in your system's keychain and nowhere else. Run banda in a desktop session with a keychain (Secret Service on Linux) to make a wallet."
					/>
				) : null}
				{wallets.length === 0 ? (
					<Rows>
						<RowOf
							title="No wallet yet"
							detail="Make one, put money in it, then choose which agents may spend from it."
							end={create}
						/>
					</Rows>
				) : (
					<>
						<Rows>
							{wallets.map((wallet) => (
								<WalletRow key={wallet.address} wallet={wallet} />
							))}
						</Rows>
						<span className="flex">{create}</span>
					</>
				)}
			</Block>
			{archived.length === 0 ? null : (
				<Block title="Archived" note="Agents can't use them and they don't send. Their keys stay in your keychain.">
					<Rows>
						{archived.map((wallet) => (
							<WalletRow key={wallet.address} wallet={wallet} />
						))}
					</Rows>
				</Block>
			)}
			<Block
				title="Networks"
				note="banda reads balances and sends payments through these. Each learns your wallets' addresses and this computer's IP address."
			>
				<Rows>
					{rpc.map((one) => (
						<RowOf
							key={one.network}
							lead={<GlobeIcon className="size-4 shrink-0 text-ink-2" />}
							title={one.network}
							detail={
								<span className="flex flex-col">
									<span className="font-code">{one.url}</span>
									{one.byDefault ? <span>banda's default, a public endpoint</span> : <span>Set by you</span>}
									{one.logs ? null : (
										<span className="flex items-center gap-1">
											<TriangleAlertIcon className="size-3 shrink-0" />
											It refuses log queries, so money coming in isn't listed.
										</span>
									)}
								</span>
							}
							end={
								<Button variant="outline" size="sm">
									Change
								</Button>
							}
						/>
					))}
				</Rows>
			</Block>
		</>
	);
}

// ── A wallet ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A wallet's balance, as large as the page's one figure, with Send and Receive beneath. */
export function WalletHero({
	wallet,
	canSend = true,
	canReceive = true,
}: {
	wallet: WalletView;
	canSend?: boolean;
	canReceive?: boolean;
}) {
	const known = wallet.usdc !== null && wallet.eth !== null;
	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-col gap-1">
				<span className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
					<Address address={wallet.address} network={wallet.network} />
				</span>
				{known ? (
					<>
						<span className="text-display font-semibold text-ink tabular-nums">
							{wallet.usdc} <span className="text-heading font-medium text-ink-2">USDC</span>
						</span>
						<span className="text-ui text-ink-2 tabular-nums">
							{wallet.eth} ETH{wallet.fiat === undefined ? null : ` · ${wallet.fiat}`}
						</span>
						<span className="text-meta text-ink-2">Read {wallet.read}</span>
					</>
				) : (
					<>
						<span className="text-display font-semibold text-ink-2">Balance unknown</span>
						<span className="text-meta text-ink-2">
							The network isn't answering.{wallet.last === undefined ? null : ` Last read ${wallet.last}.`}
						</span>
					</>
				)}
			</div>
			<span className="flex gap-2">
				<Button disabled={!canSend}>
					<ArrowUpRightIcon />
					Send
				</Button>
				<Button variant="outline" disabled={!canReceive}>
					<ArrowDownLeftIcon />
					Receive
				</Button>
			</span>
		</section>
	);
}

export type WalletTab = "activity" | "recipients" | "agents" | "wallet";

/**
 * One wallet, opened from Settings → Wallets: its balance, Send and Receive, the notices it has (at most one of each
 * kind), and its four tabs.
 */
export function WalletPage({
	wallet,
	phone = false,
	tab = "activity",
	notices,
	activity,
	recipients,
	agents,
	options,
	canSend,
	canReceive,
}: {
	wallet: WalletView;
	phone?: boolean;
	tab?: WalletTab;
	notices?: ReactNode;
	activity?: ReactNode;
	recipients?: ReactNode;
	agents?: ReactNode;
	options?: ReactNode;
	canSend?: boolean;
	canReceive?: boolean;
}) {
	const offline = wallet.offline !== undefined || wallet.archived === true;
	return (
		<SettingsPage title={wallet.name} icon={WalletIcon} parent={{ title: "Wallets", href: "#" }} phone={phone}>
			<WalletHero
				wallet={wallet}
				canSend={canSend ?? !offline}
				canReceive={canReceive ?? (wallet.offline !== "code" && wallet.backup !== "unsaved")}
			/>
			{notices === undefined ? null : <div className="flex flex-col gap-2">{notices}</div>}
			<Tabs defaultValue={tab} className="gap-6">
				<TabsList aria-label={wallet.name} className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
					<TabsTrigger value="activity">Activity</TabsTrigger>
					<TabsTrigger value="recipients">Recipients</TabsTrigger>
					<TabsTrigger value="agents">Agents</TabsTrigger>
					<TabsTrigger value="wallet">Wallet</TabsTrigger>
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
	readonly amount: string;
	readonly token: Token;
	readonly state: PaymentState;
	readonly detail?: string | undefined;
	readonly time: string;
};

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

/** One row of the list: who, to whom, in what state, how much. Opens the payment. */
export function TxRow({ row, onOpen }: { row: TxRowView; onOpen?: () => void }) {
	const money = STATUS[row.state].money;
	const who = row.by === undefined ? undefined : row.by === "you" ? "You" : row.by.name;
	const title =
		row.direction === "in"
			? `From ${row.counterpart}`
			: who === undefined
				? row.counterpart
				: `${who} paid ${row.counterpart}`;
	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-paper-2"
		>
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
		</button>
	);
}

/**
 * The wallet's activity: its payments from the store, in every state, and what came in, read from the chain; grouped
 * by day, newest first. What the list cannot know is said, never left out: an RPC that serves no logs, a range not yet
 * read.
 */
export function TransactionList({
	rows,
	incomplete,
	more = false,
	loading = false,
}: {
	rows: readonly TxRowView[];
	/** Why money coming in is listed only so far back: "Complete since 2 Nov: earlier blocks aren't read yet". */
	incomplete?: string | undefined;
	more?: boolean;
	loading?: boolean;
}) {
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
			{incomplete === undefined ? null : (
				<p className="flex items-start gap-1.5 text-meta text-ink-2">
					<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
					{incomplete}
				</p>
			)}
			{rows.length === 0 ? (
				<Rows>
					<RowOf
						title="Nothing yet"
						detail="Money that comes in, and every payment from this wallet, will show here."
					/>
				</Rows>
			) : (
				days.map((day) => (
					<section key={day} className="flex flex-col gap-2">
						<h3 className="text-meta font-medium text-ink-2">{day}</h3>
						<Rows>
							{rows
								.filter((row) => row.day === day)
								.map((row) => (
									<TxRow key={row.id} row={row} />
								))}
						</Rows>
					</section>
				))
			)}
			{more ? (
				<Button variant="ghost" size="sm" className="self-center">
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
										{version.at} · fee {version.fee} · <span className="font-code">{short(version.hash)}</span>
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
					{recipient.kind === "address" ? short(recipient.identity) : recipient.identity}
				</span>
				{recipient.paid === undefined ? null : <span className="text-meta text-ink-2">{recipient.paid}</span>}
			</span>
			<span
				className={cn(
					"shrink-0 text-right text-meta",
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

/**
 * Who may spend from the wallet: each agent of the band, switched on or off. Agents that share a wallet share its
 * balance and its Deny rules; each keeps its own Always.
 */
export function WalletAgents({
	agents,
	disabled,
}: {
	agents: readonly { agent: Who; on: boolean; detail?: string }[];
	/** Why no switch moves: an archived wallet. */
	disabled?: string | undefined;
}) {
	const on = agents.filter((one) => one.on);
	return (
		<Block title="Agents" note="Which agents may spend from this wallet, up to what's in it.">
			<Rows>
				{agents.map((one) => (
					// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
					<label key={one.agent.name} className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
						<Face face={one.agent.face} name={one.agent.name} size="message" />
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="text-ui text-ink">{one.agent.name}</span>
							{one.detail === undefined ? null : <span className="text-meta text-ink-2">{one.detail}</span>}
						</span>
						<Switch checked={one.on} disabled={disabled !== undefined} />
					</label>
				))}
			</Rows>
			{disabled !== undefined ? (
				<p className="text-meta text-ink-2">{disabled}</p>
			) : on.length > 1 ? (
				<p className="text-meta text-ink-2">
					{on.map((one) => one.agent.name).join(" and ")} share this wallet: one balance, and the same Deny rules. Each
					keeps its own Always.
				</p>
			) : null}
		</Block>
	);
}

/** The wallet in an agent's panel (Access): the ones it may spend from, or a way to give it one. */
export function AgentWallets({
	agent,
	wallets,
}: {
	agent: string;
	wallets: readonly { wallet: WalletView; on: boolean }[];
}) {
	return (
		<Block title="Wallets" note={`What ${agent} may spend. The balance is the most it can spend.`}>
			{wallets.length === 0 ? (
				<Rows>
					<RowOf
						title={`${agent} has no wallet`}
						detail="Give it one to pay for things you ask it to."
						end={
							<Button variant="outline" size="sm">
								<PlusIcon />
								Give {agent} a wallet
							</Button>
						}
					/>
				</Rows>
			) : (
				<Rows>
					{wallets.map(({ wallet, on }) => (
						// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control
						<label key={wallet.address} className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
							<WalletMark />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-ui text-ink">{wallet.name}</span>
								<span className="text-meta text-ink-2">
									{wallet.usdc === null ? "Balance unknown" : `${wallet.usdc} USDC · ${wallet.eth} ETH`}
								</span>
							</span>
							<Switch checked={on} disabled={wallet.offline !== undefined && wallet.offline !== "locked"} />
						</label>
					))}
				</Rows>
			)}
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
	rpc,
}: {
	wallet: WalletView;
	/** Whether this screen is on the computer banda runs on: a phone or a browser elsewhere never sees a key. */
	host?: boolean;
	rpc: RpcView;
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
							wallet.backup === "saved" ? null : (
								<Button variant="outline" size="sm" disabled={!host}>
									Save your key
								</Button>
							)
						}
					/>
					<RowOf
						title="Show key"
						detail={host ? "Your computer asks it's you first." : "Open banda on your computer to see it."}
						end={
							<Button variant="outline" size="sm" disabled={!host}>
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
						title={wallet.network}
						detail={
							<span>
								Fixed when the wallet was made. Read through <span className="font-code">{rpc.url}</span>.
							</span>
						}
					/>
				</Rows>
			</Block>
			<Block title={wallet.archived === true ? "Archived" : "Archive or remove"}>
				<Rows>
					<RowOf
						lead={<ArchiveIcon className="size-4 shrink-0 text-ink-2" />}
						title={wallet.archived === true ? "Unarchive" : "Archive"}
						detail={
							wallet.archived === true
								? "Agents it was on for can use it again."
								: "Agents can't use it and it doesn't send. The key stays."
						}
						end={
							<Button variant="outline" size="sm">
								{wallet.archived === true ? "Unarchive" : "Archive"}
							</Button>
						}
					/>
					<RowOf
						title="Remove"
						detail="Deletes its key from your keychain. Only when it's empty."
						end={
							<Button variant="destructive" size="sm" disabled={!host}>
								Remove
							</Button>
						}
					/>
				</Rows>
			</Block>
		</>
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
				<h2 className="text-heading font-semibold text-ink">{title}</h2>
				{body === undefined ? null : <p className="text-ui text-ink-2">{body}</p>}
			</div>
			{children}
			<div className="flex flex-wrap justify-end gap-2">{actions}</div>
		</div>
	);
}

/** Why a wallet cannot be removed yet: every reason at once, each with what to do (C17). */
export function RemoveBlocked({ wallet, reasons }: { wallet: string; reasons: readonly string[] }) {
	return (
		<WalletDialog
			title={`${wallet} can't be removed yet`}
			body="Removing deletes its key, so banda waits until nothing can be lost:"
			actions={
				<>
					<Button variant="ghost">Close</Button>
					<Button variant="destructive" disabled>
						Remove
					</Button>
				</>
			}
		>
			<ul className="flex flex-col gap-2">
				{reasons.map((reason) => (
					<li key={reason} className="flex items-start gap-2 text-ui text-ink">
						<XIcon className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
						{reason}
					</li>
				))}
			</ul>
		</WalletDialog>
	);
}

// ── Making a wallet, and saving its key ─────────────────────────────────────────────────────────────────────────────

export type CreateState = "form" | "creating" | "waiting" | "failed" | "no_keychain";

/**
 * A new wallet: a name and a network (fixed for good), and, made from an agent's settings, that agent already chosen.
 * banda makes the key on this computer and keeps it in the keychain; while the keychain does not answer, the wallet
 * waits, and it is made the moment it does. A wallet whose key could not be kept is never shown.
 */
export function CreateWallet({
	state = "form",
	name = "",
	network = "Base",
	forAgent,
	phone = false,
}: {
	state?: CreateState;
	name?: string;
	network?: Network;
	forAgent?: Who | undefined;
	phone?: boolean;
}) {
	const busy = state === "creating" || state === "waiting";
	return (
		<SettingsPage
			title="New wallet"
			icon={WalletIcon}
			parent={{ title: "Wallets", href: "#" }}
			phone={phone}
			footer={
				<>
					<Button disabled={busy || state === "no_keychain" || name.trim() === ""}>
						{busy ? <Spinner className="size-3.5" /> : null}
						{busy ? "Making the wallet" : "Make wallet"}
					</Button>
					<Button variant="ghost">Cancel</Button>
				</>
			}
		>
			{state === "waiting" ? <OfflineNotice reason="creating" /> : null}
			{state === "failed" ? (
				<WalletNotice
					icon={TriangleAlertIcon}
					tone="danger"
					title="The wallet wasn't made"
					body="Your keychain already held a key under this wallet's name, so banda changed nothing and kept nothing. Try again."
					action="Try again"
				/>
			) : null}
			{state === "no_keychain" ? (
				<WalletNotice
					icon={KeyRoundIcon}
					title="This computer has no keychain banda can use"
					body="banda keeps a wallet's key in your system's keychain, never in a file. Run banda in a desktop session to make one."
				/>
			) : null}
			{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
			<label className="flex flex-col gap-1.5">
				<span className="text-ui font-medium text-ink">Name</span>
				<Input defaultValue={name} placeholder="Travel, API credits…" disabled={busy} className="text-heading" />
			</label>
			<Block title="Network" note="A wallet stays on the network it's made on.">
				<Rows>
					{(["Base", "Base Sepolia"] as const).map((one) => (
						// biome-ignore lint/a11y/noLabelWithoutControl: the radio inside is the control
						<label key={one} className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
							<span
								aria-hidden="true"
								className={cn(
									"flex size-4 shrink-0 items-center justify-center rounded-full border",
									one === network ? "border-ink" : "border-line",
								)}
							>
								{one === network ? <span className="size-2 rounded-full bg-ink" /> : null}
							</span>
							<span className="flex flex-1 flex-col">
								<span className="text-ui text-ink">{one}</span>
								<span className="text-meta text-ink-2">
									{one === "Base"
										? "Real money: ETH and USDC, low fees."
										: "A test network: its money is worth nothing."}
								</span>
							</span>
						</label>
					))}
				</Rows>
			</Block>
			{forAgent === undefined ? null : (
				<Rows>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control */}
					<label className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
						<Face face={forAgent.face} name={forAgent.name} size="message" />
						<span className="flex flex-1 flex-col">
							<span className="text-ui text-ink">{forAgent.name} may spend from it</span>
							<span className="text-meta text-ink-2">Up to what you put in.</span>
						</span>
						<Checkbox checked disabled={busy} />
					</label>
				</Rows>
			)}
			<p className="flex items-start gap-2 text-meta text-ink-2">
				<KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
				banda makes the wallet's key on this computer and keeps it in your keychain. No one else holds it, banda's
				servers included: next, you save a copy.
			</p>
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
	| "confirm_host"
	| "elsewhere";

/** The key, as it is shown once: `0x` and 64 characters, in groups, beside the address it opens. */
function KeyBox({ hidden = false }: { hidden?: boolean }) {
	const key = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
	return (
		<div className="flex flex-col gap-2 rounded-field bg-paper-2 px-3.5 py-3">
			<span className="text-meta text-ink-2">Private key</span>
			<span
				aria-hidden={hidden}
				className={cn(
					"font-code text-body leading-relaxed text-ink [overflow-wrap:anywhere] select-all",
					hidden && "blur-sm select-none",
				)}
			>
				{grouped(key)}
			</span>
		</div>
	);
}

/**
 * Saving the key, right after the wallet is made: why it matters, the key shown once on this computer, copied (the
 * clipboard clears itself), then pasted back to check the copy. Skipped, the wallet says "Not backed up" until it is
 * saved; Receive waits until this step ends. Later, only the banda app on this computer shows it again, after the
 * computer confirms it's the owner.
 */
export function SaveKey({ step, wallet, phone = false }: { step: SaveKeyStep; wallet: WalletView; phone?: boolean }) {
	const opens = (
		<p className="text-ui text-ink-2">
			Opens <span className="font-code text-ink">{short(wallet.address)}</span> on {wallet.network}.
		</p>
	);
	const page = (children: ReactNode, footer?: ReactNode) => (
		<SettingsPage
			title="Save your key"
			icon={KeyRoundIcon}
			parent={{ title: wallet.name, href: "#" }}
			phone={phone}
			footer={footer}
		>
			{children}
		</SettingsPage>
	);
	switch (step) {
		case "intro":
			return page(
				<>
					<section className="flex flex-col gap-2">
						<h2 className="text-heading font-semibold text-ink">Save {wallet.name}'s key</h2>
						<p className="text-body text-ink-2">
							The key is the wallet. Anyone who has it can spend everything in it, and banda can't give it back if this
							computer is lost. Keep a copy where only you can open it, such as your password manager.
						</p>
					</section>
					<KeyBox hidden />
				</>,
				<>
					<Button>Show key</Button>
					<Button variant="ghost">Skip for now</Button>
				</>,
			);
		case "shown":
		case "copied":
			return page(
				<>
					<KeyBox />
					{opens}
					<span className="flex items-center gap-2">
						<Button variant="outline">
							{step === "copied" ? <CheckIcon className="text-alive" /> : <CopyIcon />}
							{step === "copied" ? "Copied" : "Copy key"}
						</Button>
						{step === "copied" ? (
							<span className="text-meta text-ink-2">Your clipboard clears itself in 0:52.</span>
						) : null}
					</span>
					<p className="text-meta text-ink-2">
						Wallet apps such as MetaMask open it as a private key. Don't send it to anyone, an agent included.
					</p>
				</>,
				<Button>I saved it</Button>,
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
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
					<label className="flex flex-col gap-1.5">
						<span className="text-ui font-medium text-ink">Your saved key</span>
						<Input
							defaultValue={step === "wrong" ? "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f36231" : ""}
							placeholder="0x…"
							aria-invalid={step === "wrong"}
							className="font-code"
						/>
						{step === "wrong" ? (
							<span className="text-meta text-danger">
								This doesn't open {short(wallet.address)}. Copy the key again, then paste it here.
							</span>
						) : null}
					</label>
				</>,
				<>
					<Button>Check</Button>
					<Button variant="ghost">Show key again</Button>
				</>,
			);
		case "saved":
			return page(
				<section className="flex flex-col items-start gap-3">
					<span className="flex size-10 items-center justify-center rounded-full bg-paper-3">
						<CheckIcon className="size-5 text-alive" />
					</span>
					<h2 className="text-heading font-semibold text-ink">{wallet.name} is backed up</h2>
					<p className="text-body text-ink-2">Your copy opens it. Next, put money in: open Receive for its address.</p>
				</section>,
				<>
					<Button>Receive</Button>
					<Button variant="ghost">Done</Button>
				</>,
			);
		case "closed":
			return page(
				<WalletNotice
					icon={ClockIcon}
					title="This window has closed"
					body="A new wallet's key shows on this screen for 10 minutes. See it again from the wallet's settings in the banda app on your computer."
				/>,
				<Button variant="ghost">Done</Button>,
			);
		case "confirm_host":
			return page(
				<section className="flex flex-col items-start gap-3">
					<span className="flex size-10 items-center justify-center rounded-full bg-paper-3">
						<FingerprintIcon className="size-5 text-ink-2" />
					</span>
					<h2 className="text-heading font-semibold text-ink">Confirm it's you</h2>
					<p className="text-body text-ink-2">
						Your computer asks for Touch ID or your password before banda shows {wallet.name}'s key. You'll see it in a
						window of its own, for a minute.
					</p>
				</section>,
				<>
					<Button>Confirm</Button>
					<Button variant="ghost">Cancel</Button>
				</>,
			);
		case "elsewhere":
			return page(
				<WalletNotice
					icon={MonitorIcon}
					title="Open banda on your computer to see the key"
					body="A wallet's key shows only on the computer banda runs on, never on a phone or in a browser elsewhere."
				/>,
				<Button variant="ghost">Done</Button>,
			);
	}
}

// ── Receive and Send ────────────────────────────────────────────────────────────────────────────────────────────────

export type ReceiveState = "ready" | "save_first" | "code";

/**
 * Receive: the address, whole and in groups, its QR and Copy, and the network it is on, said plainly, since money sent
 * on another network does not arrive here. Withheld until the key is saved or skipped; replaced by a warning when the
 * address has code.
 */
export function Receive({
	wallet,
	state = "ready",
	phone = false,
}: {
	wallet: WalletView;
	state?: ReceiveState;
	phone?: boolean;
}) {
	return (
		<SettingsPage title="Receive" icon={ArrowDownLeftIcon} parent={{ title: wallet.name, href: "#" }} phone={phone}>
			{state === "code" ? (
				<OfflineNotice reason="code" />
			) : state === "save_first" ? (
				<WalletNotice
					icon={KeyRoundIcon}
					title="Save the key first"
					body="Before you put money in, save a copy of the key, or choose to skip it."
					action="Save your key"
				/>
			) : (
				<>
					<div className="flex flex-col items-center gap-4">
						<QrCode value={wallet.address} label={`${wallet.name}'s address`} className="size-48" />
						<span className="text-center font-code text-body leading-relaxed text-ink [overflow-wrap:anywhere]">
							{grouped(wallet.address)}
						</span>
						<Button variant="outline">
							<CopyIcon />
							Copy address
						</Button>
					</div>
					<WalletNotice
						icon={GlobeIcon}
						title={`On ${wallet.network} only`}
						body={`Send ETH or USDC on ${wallet.network}. Money sent on another network doesn't arrive here; only the key you saved can get it back.`}
					/>
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
	wallet: WalletView;
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
					{wallet.name} · <span className="font-code">{short(wallet.address)}</span>
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

export type RestoreState = "form" | "wrong" | "restored";

/** Restore key: the copy the owner saved, pasted back; it must open the wallet's address, or nothing changes. */
export function RestoreKey({
	wallet,
	state = "form",
	phone = false,
}: {
	wallet: WalletView;
	state?: RestoreState;
	phone?: boolean;
}) {
	return (
		<SettingsPage
			title="Restore key"
			icon={KeyRoundIcon}
			parent={{ title: wallet.name, href: "#" }}
			phone={phone}
			footer={state === "restored" ? <Button>Done</Button> : <Button>Restore</Button>}
		>
			{state === "restored" ? (
				<section className="flex flex-col items-start gap-3">
					<span className="flex size-10 items-center justify-center rounded-full bg-paper-3">
						<CheckIcon className="size-5 text-alive" />
					</span>
					<h2 className="text-heading font-semibold text-ink">{wallet.name} is back online</h2>
					<p className="text-body text-ink-2">
						The key is in your keychain again. Payments that were in line go out now, in order.
					</p>
				</section>
			) : (
				<>
					<p className="text-body text-ink-2">
						Paste the key you saved for {wallet.name}. It must open{" "}
						<span className="font-code text-ink">{short(wallet.address)}</span>.
					</p>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control */}
					<label className="flex flex-col gap-1.5">
						<span className="text-ui font-medium text-ink">Your saved key</span>
						<Input placeholder="0x…" aria-invalid={state === "wrong"} className="font-code" />
						{state === "wrong" ? (
							<span className="text-meta text-danger">
								This key opens 0x77c1…0b3e, not {short(wallet.address)}. Nothing changed.
							</span>
						) : null}
					</label>
				</>
			)}
		</SettingsPage>
	);
}

/**
 * Move signing here: only one home signs for a wallet. On the computer banda runs on, after banda proves each key, the
 * other home stops paying and this one starts.
 */
export function MoveSigning({ wallets, phone = false }: { wallets: readonly WalletView[]; phone?: boolean }) {
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
						detail={<span className="font-code">{short(wallet.address)}</span>}
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
