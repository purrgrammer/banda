/**
 * Wallets (proposal, docs/wallets.md): every screen and every state the owner can meet. Settings → Wallets; making a
 * wallet and saving its key; a wallet with its balance, its notices and its four tabs; a payment opened; Receive and
 * Send; archive and remove; getting a wallet back online; and payments in the chat, asked and recorded. Each state is
 * named by the machine state it shows (docs/wallets/model/transitions.json), so a review can check one against the other.
 */
import { CircleSlashIcon, ExternalLinkIcon, WalletIcon } from "lucide-react";
import { type ReactNode, useContext } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { Line } from "../../chat/Line.tsx";
import { PaymentCard, type PaymentCardProps, PaymentRecord } from "../../chat/PaymentCard.tsx";
import { AppSettings, SettingsPage } from "../../chat/Settings.tsx";
import {
	AgentWallets,
	CreateWallet,
	MoveSigning,
	OFFLINE,
	OfflineNotice,
	PaymentDetail,
	Receive,
	RecipientDetail,
	RecipientsList,
	type RecipientView,
	RemoveBlocked,
	RestoreKey,
	type RpcView,
	SaveKey,
	Send,
	TransactionList,
	type TxRowView,
	WalletAgents,
	WalletDialog,
	WalletNotice,
	WalletOptions,
	WalletPage,
	WalletsSettings,
	type WalletView,
} from "../../chat/Wallets.tsx";
import { ATLAS, MARA, OCTO, SANCHO, SETTINGS } from "../fixtures.ts";
import { Labelled, Section, StageContext } from "../stage.tsx";

// EIP-55's own test vectors: addresses that belong to nobody here.
const TRAVEL_ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const CREDITS_ADDRESS = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const ANA = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
const ANA_LOOKALIKE = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FC";
const SHOP = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb";
const WEATHER_PAYS = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const STRANGER = "0x27b1fdb04752bbc536007a920d24acb045561c26";
const CODER = "0x52908400098527886E0F7030069857D2E4169EE7";

/** banda's defaults, as the home's configuration holds them until the owner changes one. */
const RPC: readonly RpcView[] = [
	{ network: "Base", url: "https://base-rpc.publicnode.com", byDefault: true, logs: true },
	{ network: "Base Sepolia", url: "https://sepolia.base.org", byDefault: true, logs: true },
];
/** The owner set Base to an RPC that refuses log queries. */
const RPC_NO_LOGS: readonly RpcView[] = [
	{ network: "Base", url: "https://mainnet.base.org", byDefault: false, logs: false },
	{ network: "Base Sepolia", url: "https://sepolia.base.org", byDefault: true, logs: true },
];

const TRAVEL: WalletView = {
	name: "Travel",
	network: "Base",
	address: TRAVEL_ADDRESS,
	usdc: "182.40",
	eth: "0.0031",
	fiat: "≈ €171.95 at 10:42",
	read: "1 min ago, at block 23,145,880",
	backup: "saved",
	agents: [MARA, SANCHO],
};
const CREDITS: WalletView = {
	name: "API credits",
	network: "Base",
	address: CREDITS_ADDRESS,
	usdc: "24.98",
	eth: "0.0000",
	read: "1 min ago, at block 23,145,880",
	backup: "skipped",
	agents: [OCTO],
};
const TEST: WalletView = {
	name: "Playground",
	network: "Base Sepolia",
	address: SHOP,
	usdc: "1000.00",
	eth: "0.5000",
	read: "2 min ago, at block 18,402,113",
	backup: "saved",
	agents: [ATLAS],
};
const NEW_WALLET: WalletView = {
	...TRAVEL,
	name: "Travel",
	usdc: "0.00",
	eth: "0.0000",
	fiat: undefined,
	backup: "unsaved",
	agents: [],
};

const ROWS: readonly TxRowView[] = [
	{
		id: "1",
		day: "Today",
		direction: "out",
		by: MARA,
		counterpart: "Ana",
		amount: "25.00",
		token: "USDC",
		state: "waiting",
		time: "10:44",
	},
	{
		id: "2",
		day: "Today",
		direction: "out",
		by: SANCHO,
		counterpart: "Bike shop",
		amount: "40.00",
		token: "USDC",
		state: "in_line",
		time: "10:43",
	},
	{
		id: "3",
		day: "Today",
		direction: "out",
		by: "you",
		counterpart: "Ana",
		amount: "12.50",
		token: "USDC",
		state: "sent",
		time: "10:42",
	},
	{
		id: "4",
		day: "Today",
		direction: "out",
		by: MARA,
		counterpart: "Weather API",
		x402: true,
		amount: "0.01",
		token: "USDC",
		state: "handed",
		time: "10:41",
	},
	{
		id: "5",
		day: "Today",
		direction: "in",
		counterpart: short(STRANGER),
		amount: "100.00",
		token: "USDC",
		state: "received",
		time: "09:58",
	},
	{
		id: "6",
		day: "Yesterday",
		direction: "out",
		by: MARA,
		counterpart: "Ana",
		amount: "25.00",
		token: "USDC",
		state: "confirmed",
		time: "18:20",
	},
	{
		id: "7",
		day: "Yesterday",
		direction: "out",
		by: MARA,
		counterpart: "Weather API",
		x402: true,
		amount: "0.01",
		token: "USDC",
		state: "settled",
		time: "07:00",
	},
	{
		id: "8",
		day: "Yesterday",
		direction: "out",
		by: SANCHO,
		counterpart: short(STRANGER),
		amount: "300.00",
		token: "USDC",
		state: "refused",
		detail: "you said no",
		time: "06:12",
	},
	{
		id: "9",
		day: "3 Nov",
		direction: "out",
		by: MARA,
		counterpart: "Bike shop",
		amount: "8.00",
		token: "USDC",
		state: "not_paid",
		detail: "no answer in 24 h",
		time: "22:00",
	},
	{
		id: "10",
		day: "3 Nov",
		direction: "out",
		by: "you",
		counterpart: "Ana",
		amount: "0.0010",
		token: "ETH",
		state: "failed",
		detail: "fee spent",
		time: "14:31",
	},
	{
		id: "11",
		day: "3 Nov",
		direction: "out",
		counterpart: "Nonce 41",
		amount: "0.0020",
		token: "ETH",
		state: "outside",
		time: "11:05",
	},
	{
		id: "12",
		day: "2 Nov",
		direction: "in",
		counterpart: short(ANA),
		amount: "0.0050",
		token: "ETH",
		state: "received",
		time: "16:40",
	},
];

/** Every state a row can show, one each, so the list's words and marks are reviewed together. */
const EVERY_STATE: readonly TxRowView[] = (
	[
		["waiting", undefined],
		["in_line", undefined],
		["signed", undefined],
		["sent", undefined],
		["included", undefined],
		["confirmed", undefined],
		["failed", "fee spent"],
		["cancelled", undefined],
		["refused", "set to Deny"],
		["not_paid", "no answer in 24 h"],
		["restored", undefined],
	] as const
)
	.map(
		([state, detail], index): TxRowView => ({
			id: `s${index}`,
			day: "A transfer, in each state",
			direction: "out",
			by: MARA,
			counterpart: "Ana",
			amount: "25.00",
			token: "USDC",
			state,
			detail,
			time: "10:42",
		}),
	)
	.concat(
		(["authorized", "handed", "settlement_pending", "settled", "expired"] as const).map(
			(state, index): TxRowView => ({
				id: `x${index}`,
				day: "An x402 payment, in each state",
				direction: "out",
				by: MARA,
				counterpart: "Weather API",
				x402: true,
				amount: "0.01",
				token: "USDC",
				state,
				time: "07:00",
			}),
		),
	)
	.concat([
		{
			id: "i1",
			day: "What the chain alone tells",
			direction: "in",
			counterpart: short(STRANGER),
			amount: "100.00",
			token: "USDC",
			state: "received",
			time: "09:58",
		},
		{
			id: "i2",
			day: "What the chain alone tells",
			direction: "out",
			counterpart: "Nonce 41",
			amount: "0.0020",
			token: "ETH",
			state: "outside",
			time: "11:05",
		},
	]);

function short(address: string) {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const RECIPIENTS: readonly RecipientView[] = [
	{
		name: "Ana",
		kind: "address",
		identity: ANA,
		rules: [
			{ agent: MARA, rule: "always" },
			{ agent: SANCHO, rule: "ask" },
		],
		paid: "75.00 USDC in 3 payments · last yesterday",
	},
	{
		name: "Weather API",
		kind: "endpoint",
		identity: "api.weather.example/v1/forecast",
		payTo: WEATHER_PAYS,
		rules: [
			{ agent: MARA, rule: "always" },
			{ agent: SANCHO, rule: "always" },
		],
		paid: "0.31 USDC in 31 payments · last today",
	},
	{
		name: "Bike shop",
		kind: "address",
		identity: SHOP,
		rules: [
			{ agent: MARA, rule: "ask" },
			{ agent: SANCHO, rule: "ask" },
		],
		paid: "8.00 USDC once · last 3 Nov",
	},
	{
		kind: "address",
		identity: STRANGER,
		rules: [
			{ agent: MARA, rule: "deny" },
			{ agent: SANCHO, rule: "deny" },
		],
	},
];

/** A screen at a fixed height, as it fills the pane: the label above names its state. */
function Screen({ label, children, tall = false }: { label: string; children: ReactNode; tall?: boolean }) {
	return (
		<Labelled label={label}>
			<div
				className={cn("flex overflow-hidden rounded-tile border border-line-soft", tall ? "h-[44rem]" : "h-[32rem]")}
			>
				{children}
			</div>
		</Labelled>
	);
}

/** A dialog over the dimmed pane. */
function Over({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Labelled label={label}>
			<div className="flex justify-center rounded-tile bg-[color-mix(in_oklch,var(--ink)_12%,var(--paper))] px-4 py-8">
				{children}
			</div>
		</Labelled>
	);
}

function usePhone() {
	return useContext(StageContext).width === "phone";
}

// ── Settings → Wallets ─────────────────────────────────────────────────────────────────────────────────────────────

function SettingsWallets({ wallets }: { wallets: ReactNode }) {
	const phone = usePhone();
	return (
		<SettingsPage title="Settings" phone={phone}>
			<AppSettings tab="wallets" data={SETTINGS} wallets={wallets} />
		</SettingsPage>
	);
}

function WalletsSettingsSection() {
	return (
		<Section
			id="wallets-settings"
			note="Settings → Wallets: every wallet with its balance (read, dated, never zero when unknown), the agents it serves and its one mark: Not backed up, or why it can't pay. Archived wallets fold beneath; each network's RPC is a named choice."
		>
			<div className="grid gap-6">
				<Screen label="No wallet yet" tall>
					<SettingsWallets wallets={<WalletsSettings wallets={[]} rpc={RPC} />} />
				</Screen>
				<Screen label="Three wallets on two networks, one not backed up, one archived" tall>
					<SettingsWallets
						wallets={
							<WalletsSettings
								wallets={[TRAVEL, CREDITS, TEST]}
								archived={[{ ...TEST, name: "Old travel", address: ANA, usdc: "0.00", eth: "0.0000", agents: [] }]}
								rpc={RPC}
							/>
						}
					/>
				</Screen>
				<Screen
					label="Each offline reason, one per wallet (signing: locked, key_missing, wrong_key, other_home; a coding agent that doesn't ask, until the signer helper, OD-11; wallet: creating; C17: code); a balance the RPC didn't give"
					tall
				>
					<SettingsWallets
						wallets={
							<WalletsSettings
								wallets={[
									{ ...TRAVEL, offline: "locked" },
									{ ...CREDITS, name: "API credits", offline: "key_missing" },
									{ ...TEST, name: "Groceries", network: "Base", offline: "wrong_key" },
									{ ...TRAVEL, name: "Household", address: SHOP, offline: "other_home" },
									{ ...CREDITS, name: "Side project", address: CODER, offline: "coding_agent" },
									{ ...NEW_WALLET, name: "Gifts", address: ANA, offline: "creating" },
									{ ...TRAVEL, name: "Old card", address: STRANGER, offline: "code" },
									{ ...TRAVEL, name: "Savings", address: WEATHER_PAYS, usdc: null, eth: null },
								]}
								rpc={RPC}
							/>
						}
					/>
				</Screen>
				<Screen label="Host mode: every wallet offline (signing: offline_host_mode)">
					<SettingsWallets
						wallets={
							<WalletsSettings
								hostMode
								wallets={[
									{ ...TRAVEL, offline: "host_mode" },
									{ ...CREDITS, offline: "host_mode" },
								]}
								rpc={RPC}
							/>
						}
					/>
				</Screen>
				<Screen label="Base set to an RPC that serves no logs (the owner's choice, in the home's configuration)" tall>
					<SettingsWallets wallets={<WalletsSettings wallets={[TRAVEL]} rpc={RPC_NO_LOGS} />} />
				</Screen>
				<Screen label="No keychain this computer can reach (headless Linux)">
					<SettingsWallets wallets={<WalletsSettings wallets={[]} keychain="none" rpc={RPC} />} />
				</Screen>
			</div>
		</Section>
	);
}

// ── Making a wallet and saving its key ─────────────────────────────────────────────────────────────────────────────

function WalletCreateSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-create"
			note="A name and a network, fixed for good. The key is made on this computer and kept in the keychain; while the keychain doesn't answer the wallet waits (creating), and a wallet whose key wasn't kept is never shown."
		>
			<div className="grid gap-6">
				<Screen label="The form (wallet: none)">
					<CreateWallet name="" phone={phone} />
				</Screen>
				<Screen label="From Mara's settings: Give Mara a wallet">
					<CreateWallet name="Mara's travel" forAgent={MARA} phone={phone} />
				</Screen>
				<Screen label="Making it (wallet: creating)">
					<CreateWallet state="creating" name="Travel" phone={phone} />
				</Screen>
				<Screen label="The keychain doesn't answer: it waits, and resumes (wallet: creating, E1)">
					<CreateWallet state="waiting" name="Travel" phone={phone} />
				</Screen>
				<Screen label="An item already there, or a read-back that differs: nothing kept (wallet: dropped)">
					<CreateWallet state="failed" name="Travel" phone={phone} />
				</Screen>
				<Screen label="No keychain">
					<CreateWallet state="no_keychain" name="Travel" phone={phone} />
				</Screen>
			</div>
		</Section>
	);
}

function WalletKeySection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-key"
			note="Saving the key right after the wallet is made, on this computer only: why, the key shown once and copied (the clipboard clears itself), then pasted back to check. Skipped, the wallet says Not backed up. Later, only the banda app on this computer shows it again, after the computer confirms it's you."
		>
			<div className="grid gap-6">
				<Screen label="Why it matters (wallet: ready_unsaved)">
					<SaveKey step="intro" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="Shown">
					<SaveKey step="shown" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="Copied, the clipboard counting down">
					<SaveKey step="copied" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="Check the copy">
					<SaveKey step="check" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="The copy doesn't open it (stays ready_unsaved)">
					<SaveKey step="wrong" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="Backed up (wallet: ready_saved)">
					<SaveKey step="saved" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="The 10 minutes passed">
					<SaveKey step="closed" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="Later, on this computer: confirm it's you first">
					<SaveKey step="confirm_host" wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="On a phone or another browser: never">
					<SaveKey step="elsewhere" wallet={TRAVEL} phone={phone} />
				</Screen>
			</div>
		</Section>
	);
}

// ── A wallet ───────────────────────────────────────────────────────────────────────────────────────────────────────

function WalletPageSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-page"
			note="A wallet, opened: its balance as the page's one figure, Send and Receive, then Activity, Recipients, Agents and Wallet. Each tab as it opens."
		>
			<div className="grid gap-6">
				<Screen label="Activity" tall>
					<WalletPage wallet={TRAVEL} phone={phone} activity={<TransactionList rows={ROWS} more />} />
				</Screen>
				<Screen label="Recipients" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tab="recipients"
						recipients={<RecipientsList recipients={RECIPIENTS} />}
					/>
				</Screen>
				<Screen label="Agents" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tab="agents"
						agents={
							<WalletAgents
								agents={[
									{ agent: MARA, on: true, detail: "Paid 4 times this week" },
									{ agent: SANCHO, on: true, detail: "Paid once this week" },
									{ agent: OCTO, on: false },
									{ agent: ATLAS, on: false },
								]}
							/>
						}
					/>
				</Screen>
				<Screen label="Wallet" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tab="wallet"
						options={<WalletOptions wallet={TRAVEL} rpc={RPC[0] as RpcView} />}
					/>
				</Screen>
				<Screen label="Wallet, not backed up, on a phone (no key here)" tall>
					<WalletPage
						wallet={CREDITS}
						phone={phone}
						tab="wallet"
						options={<WalletOptions wallet={CREDITS} host={false} rpc={RPC[0] as RpcView} />}
					/>
				</Screen>
			</div>
		</Section>
	);
}

function WalletNoticesSection() {
	const phone = usePhone();
	const page = (wallet: WalletView, notices: ReactNode, extra?: { canSend?: boolean; canReceive?: boolean }) => (
		<WalletPage
			wallet={wallet}
			phone={phone}
			notices={notices}
			activity={<TransactionList rows={ROWS.slice(0, 3)} />}
			{...extra}
		/>
	);
	return (
		<Section
			id="wallet-notices"
			note="What a wallet says about itself, at most one notice of each kind, each with its one fix. Offline, Send waits; with code at the address, Receive gives way to the warning."
		>
			<div className="grid gap-6">
				<Screen label="Not backed up (wallet: ready_skipped)" tall>
					{page(
						CREDITS,
						<WalletNotice
							icon={OFFLINE.key_missing.icon}
							title="Not backed up"
							body="Now that it holds money: if this computer is lost, so is what's in this wallet."
							action="Save your key"
						/>,
					)}
				</Screen>
				{(["locked", "key_missing", "wrong_key", "other_home", "host_mode", "coding_agent", "code"] as const).map(
					(reason) => (
						<Screen key={reason} label={`Offline: ${OFFLINE[reason].title} (${reason})`} tall>
							{page({ ...TRAVEL, offline: reason }, <OfflineNotice reason={reason} />)}
						</Screen>
					),
				)}
				<Screen label="The network isn't answering: unknown, never zero" tall>
					{page({ ...TRAVEL, usdc: null, eth: null, last: "182.40 USDC at 09:12" }, undefined)}
				</Screen>
				<Screen label="USDC but no ETH for the network fee" tall>
					{page(
						{ ...CREDITS, backup: "saved" },
						<WalletNotice
							icon={OFFLINE.creating.icon}
							title="Add a little ETH"
							body="Sending USDC costs a network fee in ETH. Agents can still pay x402 requests, which cost them no fee."
							action="Receive"
						/>,
					)}
				</Screen>
				<Screen label="Paused: the key was used outside banda twice in a day" tall>
					{page(
						TRAVEL,
						<WalletNotice
							icon={ExternalLinkIcon}
							title="Paused: your key paid from somewhere else"
							body="Twice in 24 hours a payment left this wallet outside banda. Agents' payments wait until you check it."
							action="Resume"
						/>,
						{ canSend: false },
					)}
				</Screen>
				<Screen label="x402 paused: this computer's clock is off" tall>
					{page(
						TRAVEL,
						<WalletNotice
							icon={OFFLINE.creating.icon}
							title="x402 payments paused"
							body="This computer's clock is 3 minutes off the network's, and banda signs x402 payments only while the two agree within 2 minutes. Check this computer's date and time. Transfers still go."
						/>,
					)}
				</Screen>
				<Screen label="Archived (wallet: archived)" tall>
					{page(
						{ ...TRAVEL, archived: true },
						<WalletNotice
							icon={OFFLINE.other_home.icon}
							title="Archived"
							body="Agents can't use it and it doesn't send. Money can still arrive."
							action="Unarchive"
						/>,
					)}
				</Screen>
			</div>
		</Section>
	);
}

function WalletActivitySection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-activity"
			note="Activity: every payment from the store in its state (a stored Queued reads In line; Signed reads May have sent), x402 payments, and what the chain alone tells: money in, and a nonce spent outside banda. A payment that didn't leave is struck through."
		>
			<div className="grid gap-6">
				<Labelled label="Every state a row shows">
					<TransactionList rows={EVERY_STATE} />
				</Labelled>
				<Screen label="Nothing yet">
					<WalletPage wallet={NEW_WALLET} phone={phone} activity={<TransactionList rows={[]} />} canReceive />
				</Screen>
				<Screen label="Reading">
					<WalletPage wallet={TRAVEL} phone={phone} activity={<TransactionList rows={[]} loading />} />
				</Screen>
				<Screen label="Base set to an RPC that serves no logs: money in isn't listed" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						activity={
							<TransactionList
								rows={ROWS.filter((row) => row.direction === "out").slice(0, 5)}
								incomplete="Money coming in isn't listed: mainnet.base.org refuses log queries. Choose another RPC in Settings → Wallets."
							/>
						}
					/>
				</Screen>
				<Screen label="Still reading back: complete since a date" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						activity={
							<TransactionList
								rows={ROWS.slice(0, 6)}
								incomplete="Complete since 2 Nov. banda is still reading earlier blocks."
							/>
						}
					/>
				</Screen>
			</div>
		</Section>
	);
}

function PaymentPage({ title, children }: { title: string; children: ReactNode }) {
	const phone = usePhone();
	return (
		<SettingsPage title={title} icon={WalletIcon} parent={{ title: "Travel", href: "#" }} phone={phone}>
			{children}
		</SettingsPage>
	);
}

function WalletPaymentSection() {
	const ana = { name: "Ana", identity: ANA, network: "Base" as const };
	return (
		<Section
			id="wallet-payment"
			note="A payment, opened from its row or its card: every fact to check, each version signed at its nonce (a fee raised is a new version), and Cancel while it's Sent. Confirmed, Failed and Cancelled only once the network finalizes."
		>
			<div className="grid gap-6">
				<Screen label="Sent, its fee raised once, Cancel offered" tall>
					<PaymentPage title="Payment">
						<PaymentDetail
							title="Mara paid Ana"
							by={MARA}
							amount="25.00"
							token="USDC"
							fiat="≈ €23.55 at 10:42"
							state="sent"
							to={ana}
							from="Travel · 0x5aAe…eAed"
							reason="The 9:15 to Lisbon, window seat: Ana is booking it for us."
							approved="Always pay Ana, set 3 Nov on this computer"
							versions={[
								{
									label: "Sent",
									at: "10:42",
									fee: "0.0000041 ETH",
									hash: "0x9a1c4be2f0d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
								},
								{
									label: "Fee raised",
									at: "10:46",
									fee: "0.0000052 ETH",
									hash: "0x1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c",
								},
							]}
							cancel="offer"
						/>
					</PaymentPage>
				</Screen>
				<Screen label="Cancelling: whichever lands decides" tall>
					<PaymentPage title="Payment">
						<PaymentDetail
							title="You sent Ana"
							by="you"
							amount="12.50"
							token="USDC"
							state="sent"
							to={ana}
							from="Travel · 0x5aAe…eAed"
							versions={[
								{
									label: "Sent",
									at: "10:42",
									fee: "0.0000041 ETH",
									hash: "0x2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d",
								},
								{
									label: "Your cancel",
									at: "10:50",
									fee: "0.0000060 ETH",
									hash: "0x3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
								},
							]}
							cancel="cancelling"
						/>
					</PaymentPage>
				</Screen>
				<Screen label="Cancelled (payment: Cancelled)">
					<PaymentPage title="Payment">
						<PaymentDetail
							title="You sent Ana"
							by="you"
							amount="12.50"
							token="USDC"
							state="cancelled"
							to={ana}
							from="Travel · 0x5aAe…eAed"
							cancel="cancelled"
						/>
					</PaymentPage>
				</Screen>
				<Screen label="The payment landed before the cancel (payment: Confirmed)">
					<PaymentPage title="Payment">
						<PaymentDetail
							title="You sent Ana"
							by="you"
							amount="12.50"
							token="USDC"
							state="confirmed"
							to={ana}
							from="Travel · 0x5aAe…eAed"
							cancel="paid_anyway"
						/>
					</PaymentPage>
				</Screen>
				<Screen label="May have sent: signed and stored, the network hasn't said (payment: Signed)">
					<PaymentPage title="Payment">
						<PaymentDetail
							title="Mara paid Ana"
							by={MARA}
							amount="25.00"
							token="USDC"
							state="signed"
							to={ana}
							from="Travel · 0x5aAe…eAed"
							explain={{
								tone: "quiet",
								title: "The run stopped after this was signed",
								body: "It may already be on the network, so banda follows it to the end and tells the chat. It's never sent twice.",
							}}
						/>
					</PaymentPage>
				</Screen>
				<Screen label="Failed: the network refused it, the fee was spent (payment: Failed)">
					<PaymentPage title="Payment">
						<PaymentDetail
							title="You sent Ana"
							by="you"
							amount="0.0010"
							token="ETH"
							state="failed"
							to={ana}
							from="Travel · 0x5aAe…eAed"
							explain={{
								tone: "danger",
								title: "Ana's address refused it",
								body: "The network ran it and it failed, so 0.0010 ETH stayed here; the fee of 0.0000041 ETH was spent.",
							}}
						/>
					</PaymentPage>
				</Screen>
				<Screen label="Restored from a backup, never sent (payment: Restored)">
					<PaymentPage title="Payment">
						<PaymentDetail
							title="Mara paid Bike shop"
							by={MARA}
							amount="8.00"
							token="USDC"
							state="restored"
							to={{ name: "Bike shop", identity: SHOP, network: "Base" }}
							from="Travel · 0x5aAe…eAed"
							explain={{
								tone: "quiet",
								title: "This home was restored from a backup",
								body: "The backup was made before this payment was signed, so it never left and never will. Ask Mara again if it's still wanted.",
							}}
						/>
					</PaymentPage>
				</Screen>
				<Screen label="Sent outside banda: the exported key used elsewhere">
					<PaymentPage title="Payment">
						<PaymentDetail
							title="Sent outside banda"
							amount="0.0020"
							token="ETH"
							state="outside"
							to={{ identity: STRANGER, network: "Base" }}
							from="Travel · 0x5aAe…eAed"
							explain={{
								tone: "quiet",
								title: "Someone used this wallet's key outside banda",
								body: "If that was you, in another wallet app, nothing is wrong. If not, move the money to a new wallet.",
							}}
						/>
					</PaymentPage>
				</Screen>
				<Screen label="An x402 payment: authorized, then settled (x402: handed → settled)">
					<PaymentPage title="Payment">
						<PaymentDetail
							title="Mara paid for a request"
							by={MARA}
							amount="0.01"
							token="USDC"
							state="settlement_pending"
							to={{
								name: "Weather API",
								identity: WEATHER_PAYS,
								network: "Base",
								endpoint: "api.weather.example/v1/forecast",
							}}
							from="Travel · 0x5aAe…eAed"
							approved="Always pay Weather API, set 1 Nov"
							explain={{
								tone: "quiet",
								title: "The service says it's settling",
								body: "banda waits for the network's word. If it isn't used by 10:42:30, it expires and nothing is paid.",
							}}
						/>
					</PaymentPage>
				</Screen>
			</div>
		</Section>
	);
}

// ── Recipients and agents ──────────────────────────────────────────────────────────────────────────────────────────

function RecipientPage({ title, children }: { title: string; children: ReactNode }) {
	const phone = usePhone();
	return (
		<SettingsPage title={title} icon={WalletIcon} parent={{ title: "Recipients", href: "#" }} phone={phone}>
			{children}
		</SettingsPage>
	);
}

function WalletRecipientsSection() {
	const phone = usePhone();
	const ana = RECIPIENTS[0] as RecipientView;
	return (
		<Section
			id="wallet-recipients"
			note="Recipients: an address or an x402 endpoint, kept by what the daemon can verify, with the owner's name for it. Always is an agent's; Deny holds for every agent of the wallet; new recipients Ask (Deny is the owner's opt-in, OD-13)."
		>
			<div className="grid gap-6">
				<Screen label="None yet" tall>
					<WalletPage
						wallet={NEW_WALLET}
						phone={phone}
						tab="recipients"
						recipients={<RecipientsList recipients={[]} />}
						canReceive
					/>
				</Screen>
				<Screen label="New recipients denied (the opt-in)" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tab="recipients"
						recipients={<RecipientsList recipients={RECIPIENTS} unknown="deny" />}
					/>
				</Screen>
				<Screen label="Changed on another device first: redrawn, nothing applied" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tab="recipients"
						recipients={<RecipientsList recipients={RECIPIENTS} stale />}
					/>
				</Screen>
				<Screen label="Ana: Always for Mara, Ask for Sancho" tall>
					<RecipientPage title="Ana">
						<RecipientDetail recipient={ana} />
					</RecipientPage>
				</Screen>
				<Screen label="An endpoint: what it pays is part of what it is" tall>
					<RecipientPage title="Weather API">
						<RecipientDetail recipient={RECIPIENTS[1] as RecipientView} />
					</RecipientPage>
				</Screen>
				<Screen label="Denied, unnamed, renaming" tall>
					<RecipientPage title="0x27b1…1c26">
						<RecipientDetail recipient={RECIPIENTS[3] as RecipientView} editing />
					</RecipientPage>
				</Screen>
				<Screen label="A look-alike of Ana" tall>
					<RecipientPage title="0xdbF0…C6FC">
						<RecipientDetail
							recipient={{
								kind: "address",
								identity: ANA_LOOKALIKE,
								rules: [
									{ agent: MARA, rule: "ask" },
									{ agent: SANCHO, rule: "ask" },
								],
								lookalike: `It differs from Ana's address by its last character: ${short(ANA_LOOKALIKE)} here, ${short(ANA)} for Ana.`,
							}}
						/>
					</RecipientPage>
				</Screen>
				<Over label="Forget a recipient">
					<WalletDialog
						title="Forget Ana?"
						body="Its name and rules go. The next time an agent pays 0xdbF0…C6FB, it asks you again. Payments already made stay in Activity."
						actions={
							<>
								<Button variant="ghost">Cancel</Button>
								<Button variant="destructive">Forget</Button>
							</>
						}
					/>
				</Over>
			</div>
		</Section>
	);
}

function WalletAgentsSection() {
	return (
		<Section
			id="wallet-agents"
			note="Who may spend from a wallet, from the wallet's side and from the agent's: switched on per agent, as any account of a connection. Agents sharing a wallet share its balance and its Deny rules; each keeps its own Always."
		>
			<div className="@container w-full min-w-0">
				<div className="grid gap-6 @2xl:grid-cols-2">
					<Labelled label="The wallet's Agents tab, shared by two">
						<WalletAgents
							agents={[
								{ agent: MARA, on: true, detail: "Paid 4 times this week" },
								{ agent: SANCHO, on: true },
								{ agent: OCTO, on: false },
							]}
						/>
					</Labelled>
					<Labelled label="Archived: no switch moves">
						<WalletAgents
							agents={[
								{ agent: MARA, on: true },
								{ agent: SANCHO, on: false },
							]}
							disabled="Archived wallets serve no agent. Unarchive it first."
						/>
					</Labelled>
					<Labelled label="Mara's panel, Access: her wallets">
						<AgentWallets
							agent="Mara"
							wallets={[
								{ wallet: TRAVEL, on: true },
								{ wallet: { ...CREDITS, offline: "key_missing" }, on: false },
							]}
						/>
					</Labelled>
					<Labelled label="Mara's panel, Access: none yet">
						<AgentWallets agent="Mara" wallets={[]} />
					</Labelled>
				</div>
			</div>
		</Section>
	);
}

// ── Receive and Send ───────────────────────────────────────────────────────────────────────────────────────────────

function WalletReceiveSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-receive"
			note="Receive: the address in full and in groups, its QR (the plain address) and Copy, and the network, said plainly. Withheld until the key is saved or skipped; with code at the address, a warning instead."
		>
			<div className="grid gap-6">
				<Screen label="Ready" tall>
					<Receive wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="Before the key is saved or skipped">
					<Receive wallet={NEW_WALLET} state="save_first" phone={phone} />
				</Screen>
				<Screen label="The address has code (C17)">
					<Receive wallet={TRAVEL} state="code" phone={phone} />
				</Screen>
			</div>
		</Section>
	);
}

function WalletSendSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-send"
			note="Send, the owner's own: to a recipient or an address, an amount, then a review with the whole address, the network and the fee. It joins the wallet's line behind agents' payments already there. Errors stand beside the field that has them."
		>
			<div className="grid gap-6">
				<Screen label="Empty">
					<Send wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="Not an address on Base; too many decimals">
					<Send
						wallet={TRAVEL}
						phone={phone}
						to="0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6F"
						amount="12.5000001"
						toError="That isn't a whole address: an address has 40 characters after 0x."
						amountError="USDC has 6 decimals at most."
					/>
				</Screen>
				<Screen label="More than is available; a comma for decimals">
					<Send
						wallet={TRAVEL}
						phone={phone}
						to={ANA}
						amount="250,00"
						amountError="Use a dot for decimals: 250.00. And Travel has 182.40 USDC available."
					/>
				</Screen>
				<Screen label="ETH, keeping a little for fees">
					<Send wallet={TRAVEL} phone={phone} to={ANA} amount="0.0029" token="ETH" />
				</Screen>
				<Screen label="Review: a recipient the wallet knows" tall>
					<Send
						wallet={TRAVEL}
						phone={phone}
						step="review"
						amount="12.50"
						review={{ name: "Ana", address: ANA, fee: "≈ 0.0000041 ETH (€0.01)" }}
					/>
				</Screen>
				<Screen label="Review: a first payment to an address" tall>
					<Send
						wallet={TRAVEL}
						phone={phone}
						step="review"
						amount="40.00"
						review={{ address: STRANGER, fee: "≈ 0.0000041 ETH (€0.01)", newAddress: true }}
					/>
				</Screen>
				<Screen label="Review: set to Deny for agents, sent by you" tall>
					<Send
						wallet={TRAVEL}
						phone={phone}
						step="review"
						amount="5.00"
						review={{ name: "Old landlord", address: STRANGER, fee: "≈ 0.0000041 ETH (€0.01)", deniedForAgents: true }}
					/>
				</Screen>
				<Screen label="Review on a phone: a new address waits for the computer (OD-3)" tall>
					<Send
						wallet={TRAVEL}
						phone={phone}
						fromPhone
						step="review"
						amount="40.00"
						review={{ address: STRANGER, fee: "≈ 0.0000041 ETH (€0.01)", newAddress: true }}
					/>
				</Screen>
				<Screen label="Review: the address has code, sent only once acknowledged" tall>
					<Send
						wallet={TRAVEL}
						phone={phone}
						step="review"
						amount="12.50"
						review={{ name: "Ana", address: ANA, fee: "≈ 0.0000041 ETH (€0.01)", code: true }}
					/>
				</Screen>
				<Screen label="Sending" tall>
					<Send
						wallet={TRAVEL}
						phone={phone}
						step="sending"
						amount="12.50"
						review={{ name: "Ana", address: ANA, fee: "≈ 0.0000041 ETH (€0.01)" }}
					/>
				</Screen>
			</div>
		</Section>
	);
}

// ── Archive, remove, back online ───────────────────────────────────────────────────────────────────────────────────

function WalletRemoveSection() {
	return (
		<Section
			id="wallet-remove"
			note="Archive hides a wallet from agents and refuses what waits on it, keeping the key. Remove deletes the key, so it waits until nothing can be lost (C17): no payment in flight, no live authorization, nothing at safe, and a key that was saved if the address was ever shown."
		>
			<div className="grid gap-6">
				<Over label="Archive">
					<WalletDialog
						title="Archive Travel?"
						body="Mara and Sancho can't use it and it doesn't send. The payment waiting on you and the one in line are refused. The key stays in your keychain, and you can unarchive it."
						actions={
							<>
								<Button variant="ghost">Cancel</Button>
								<Button variant="destructive">Archive</Button>
							</>
						}
					/>
				</Over>
				<Over label="Remove, refused: every reason at once">
					<RemoveBlocked
						wallet="Travel"
						reasons={[
							"182.40 USDC and 0.0031 ETH are still in it. Send them elsewhere first.",
							"A payment to Ana isn't final yet.",
							"An x402 payment can still be used until 10:42:30.",
							"Its address was shown, and its key was never saved.",
						]}
					/>
				</Over>
				<Over label="Remove, allowed">
					<WalletDialog
						title="Remove Old travel?"
						body="banda deletes its key from your keychain. Without the copy you saved, no one can open 0xdbF0…C6FB again. Its activity stays in banda."
						actions={
							<>
								<Button variant="ghost">Cancel</Button>
								<Button variant="destructive">Remove</Button>
							</>
						}
					/>
				</Over>
				<Over label="Removing: the keychain doesn't answer (wallet: removing)">
					<WalletDialog
						title="Removing Old travel"
						body="Waiting for your keychain to delete the key. Unlock it, or answer its prompt."
						actions={
							<Button variant="ghost" disabled>
								Removing
							</Button>
						}
					/>
				</Over>
				<Labelled label="Money arrived while removing: stopped, archived instead">
					<WalletNotice
						icon={OFFLINE.creating.icon}
						title="Removal stopped"
						body="50.00 USDC arrived while Old travel was being removed, so nothing was deleted. The wallet is archived."
					/>
				</Labelled>
			</div>
		</Section>
	);
}

function WalletOnlineSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-online"
			note="Getting a wallet back online: restore the key from the copy saved (it must open the address), or move signing to this home (one signing home per wallet, on the computer banda runs on)."
		>
			<div className="grid gap-6">
				<Screen label="Restore key">
					<RestoreKey wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="A key that opens another address: nothing changes">
					<RestoreKey wallet={TRAVEL} state="wrong" phone={phone} />
				</Screen>
				<Screen label="Restored: payments in line go out">
					<RestoreKey wallet={TRAVEL} state="restored" phone={phone} />
				</Screen>
				<Screen label="Move signing here (signing: other_home)">
					<MoveSigning wallets={[TRAVEL, CREDITS]} phone={phone} />
				</Screen>
			</div>
		</Section>
	);
}

// ── Payments in the chat ───────────────────────────────────────────────────────────────────────────────────────────

const ASK: PaymentCardProps = {
	agent: "Mara",
	kind: "transfer",
	amount: "25.00",
	token: "USDC",
	fiat: "≈ €23.55 at 10:42",
	recipient: { name: "Ana", identity: ANA, network: "Base" },
	wallet: { name: "Travel", after: "157.40 USDC" },
	reason: "The 9:15 to Lisbon, window seat: Ana is booking it for us.",
};

const X402: PaymentCardProps = {
	agent: "Mara",
	kind: "x402",
	amount: "0.01",
	token: "USDC",
	recipient: {
		identity: "api.weather.example/v1/forecast",
		payTo: WEATHER_PAYS,
		network: "Base",
		isNew: true,
		suggested: "Weather API",
	},
	wallet: { name: "Travel", after: "182.39 USDC" },
	reason: "Tomorrow's forecast for Lisbon, for the umbrella check.",
};

function PaymentCardsSection() {
	const phone = usePhone();
	return (
		<Section
			id="payment-cards"
			note="The first payment's card (payment: Waiting): the amount, the recipient as the daemon identified it, the wallet and its balance after, and the agent's reason in its words. Pay, Always pay, Don't pay, Never pay; a new recipient is named first. Then each way it settles, the card's height kept."
		>
			<div className="@container w-full min-w-0">
				<div className="grid gap-6 @2xl:grid-cols-2">
					<Labelled label="A new address, a name suggested">
						<PaymentCard
							{...ASK}
							recipient={{ identity: ANA, network: "Base", isNew: true, suggested: "Ana" }}
							phone={phone}
						/>
					</Labelled>
					<Labelled label="Ana, whose rule is Ask">
						<PaymentCard {...ASK} />
					</Labelled>
					<Labelled label="A look-alike of Ana">
						<PaymentCard
							{...ASK}
							recipient={{
								identity: ANA_LOOKALIKE,
								network: "Base",
								isNew: true,
								lookalike: `It differs from Ana's address by its last character: ${short(ANA_LOOKALIKE)} here, ${short(ANA)} for Ana.`,
							}}
						/>
					</Labelled>
					<Labelled label="Shared wallet: Mara already pays Ana always">
						<PaymentCard {...ASK} agent="Sancho" sharedWith="Mara" reason="The bike's new chain, from Ana's shop." />
					</Labelled>
					<Labelled label="An x402 request, first time">
						<PaymentCard {...X402} phone={phone} />
					</Labelled>
					<Labelled label="Asks again: the yes was over an hour old when its turn came (C10)">
						<PaymentCard
							{...ASK}
							again="Asking again: you said pay at 08:10, and the payment was still in line an hour later."
						/>
					</Labelled>
					<Labelled label="Asks again: the key paid something else in its place (C7)">
						<PaymentCard
							{...ASK}
							again="This wasn't sent: your key paid something outside banda at the same moment. Pay it now?"
						/>
					</Labelled>
					<Labelled label="Answered on the phone, new to the computer: the computer confirms">
						<PaymentCard
							{...ASK}
							recipient={{ ...ASK.recipient, name: undefined, isNew: true, suggested: "Ana" }}
							state={{ kind: "host" }}
						/>
					</Labelled>
					<Labelled label="Pay, this once: in line, then sent">
						<PaymentCard {...ASK} state={{ kind: "paid", answer: "once", status: "sent" }} />
					</Labelled>
					<Labelled label="Always pay Ana: confirmed">
						<PaymentCard {...ASK} state={{ kind: "paid", answer: "always", status: "confirmed" }} />
					</Labelled>
					<Labelled label="Don't pay">
						<PaymentCard {...ASK} state={{ kind: "declined", never: false }} />
					</Labelled>
					<Labelled label="Never pay Ana (sets Deny for the wallet)">
						<PaymentCard {...ASK} state={{ kind: "declined", never: true }} />
					</Labelled>
					<Labelled label="No answer in 24 hours (payment: NotPaid)">
						<PaymentCard {...ASK} state={{ kind: "closed", icon: "clock", words: "Not paid: no answer in 24 hours" }} />
					</Labelled>
					<Labelled label="Deny set before it went (payment: Refused at the start commit)">
						<PaymentCard
							{...ASK}
							state={{ kind: "closed", icon: "slash", words: "Not paid: you set Ana to Deny before it went" }}
						/>
					</Labelled>
					<Labelled label="Answered on another device first">
						<PaymentCard
							{...ASK}
							state={{ kind: "closed", icon: "device", words: "Answered on your phone: paid this once" }}
						/>
					</Labelled>
					<Labelled label="The run was stopped while it waited">
						<PaymentCard
							{...ASK}
							state={{ kind: "closed", icon: "slash", words: "Not paid: you stopped Mara's run" }}
						/>
					</Labelled>
				</div>
			</div>
		</Section>
	);
}

function PaymentRecordsSection() {
	return (
		<Section
			id="payment-records"
			note="A payment that didn't ask (Always) is a record in the chat, followed to the network's last word. A refusal that needs no answer is a line, never a card: Deny, too little in the wallet, a wallet that can't pay."
		>
			<div className="@container w-full min-w-0">
				<div className="grid gap-6 @2xl:grid-cols-2">
					<Labelled label="In line">
						<PaymentRecord agent="Mara" amount="25.00" token="USDC" to="Ana" wallet="Travel" status="in_line" />
					</Labelled>
					<Labelled label="Included, confirming">
						<PaymentRecord agent="Mara" amount="25.00" token="USDC" to="Ana" wallet="Travel" status="included" />
					</Labelled>
					<Labelled label="Confirmed">
						<PaymentRecord agent="Mara" amount="25.00" token="USDC" to="Ana" wallet="Travel" status="confirmed" />
					</Labelled>
					<Labelled label="Failed">
						<PaymentRecord
							agent="Mara"
							amount="25.00"
							token="USDC"
							to="Ana"
							wallet="Travel"
							status="failed"
							note="The network refused it: the 25.00 USDC stayed in Travel, the fee was spent."
						/>
					</Labelled>
					<Labelled label="Cancelled by you">
						<PaymentRecord agent="Mara" amount="25.00" token="USDC" to="Ana" wallet="Travel" status="cancelled" />
					</Labelled>
					<Labelled label="x402: settled">
						<PaymentRecord
							agent="Mara"
							kind="x402"
							amount="0.01"
							token="USDC"
							to="Weather API"
							wallet="Travel"
							status="settled"
						/>
					</Labelled>
					<Labelled label="x402: expired, nothing paid">
						<PaymentRecord
							agent="Mara"
							kind="x402"
							amount="0.01"
							token="USDC"
							to="Weather API"
							wallet="Travel"
							status="expired"
						/>
					</Labelled>
					<Labelled label="Refusals that need no answer">
						<div className="flex flex-col gap-3 py-2">
							<Line icon={CircleSlashIcon}>Mara didn't pay 0x27b1…1c26: it's set to Deny.</Line>
							<Line icon={CircleSlashIcon}>Mara couldn't pay Ana 300.00 USDC: Travel has 182.40 USDC available.</Line>
							<Line icon={CircleSlashIcon}>
								Mara didn't pay 0x27b1…1c26: Travel pays only the recipients you set up.
							</Line>
							<Line icon={CircleSlashIcon} action={{ label: "Open Travel" }}>
								Mara couldn't pay: Travel is offline, its keychain is locked.
							</Line>
							<Line icon={CircleSlashIcon} action={{ label: "Receive" }}>
								Mara couldn't pay Ana: API credits needs a little ETH for the network fee.
							</Line>
						</div>
					</Labelled>
				</div>
			</div>
		</Section>
	);
}

export function WalletSections() {
	return (
		<>
			<WalletsSettingsSection />
			<WalletCreateSection />
			<WalletKeySection />
			<WalletPageSection />
			<WalletNoticesSection />
			<WalletActivitySection />
			<WalletPaymentSection />
			<WalletRecipientsSection />
			<WalletAgentsSection />
			<WalletReceiveSection />
			<WalletSendSection />
			<WalletRemoveSection />
			<WalletOnlineSection />
			<PaymentCardsSection />
			<PaymentRecordsSection />
		</>
	);
}
