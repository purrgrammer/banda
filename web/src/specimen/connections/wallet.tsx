/**
 * Wallets (docs/wallets.md): every screen and every state the owner can meet. Settings → Wallets; making a
 * wallet and saving its key; a wallet with its balance, its notices and its four tabs; a payment opened; Receive and
 * Send; archive and remove; getting a wallet back online; and payments in the chat, asked and recorded. Each state is
 * named by the machine state it shows (docs/wallets/model/transitions.json), so a review can check one against the other.
 */
import { CircleSlashIcon, ExternalLinkIcon, WalletIcon } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { shortAddress } from "../../../../src/wallet/label.ts";
import { activityRows, incomingRows } from "../../app/wallets.ts";
import { OFFERED_TABS } from "../../app/where.ts";
import { Confirm } from "../../chat/Confirm.tsx";
import { Line } from "../../chat/Line.tsx";
import { PaymentCard, type PaymentCardProps, PaymentRecord } from "../../chat/PaymentCard.tsx";
import { AppSettings, SettingsPage } from "../../chat/Settings.tsx";
import {
	type ActivityRowView,
	AgentWallets,
	ArchivedNotice,
	archiveWords,
	CreateWallet,
	MoveSigning,
	NoWallet,
	OFFLINE,
	OfflineNotice,
	type OfflineReason,
	PaymentDetail,
	Receive,
	RecipientDetail,
	RecipientsList,
	type RecipientView,
	RemoveRefused,
	RemovingNotice,
	RestoreKey,
	type RpcView,
	removeWords,
	SaveKey,
	Send,
	type ShownWallet,
	TransactionList,
	type TxRowView,
	WalletAgents,
	WalletDialog,
	WalletNotice,
	WalletOptions,
	WalletPage,
	WalletsSettings,
	WhichWallet,
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
/**
 * The wallets a list shows besides Travel, API credits and Playground, one address each so no two rows look alike:
 * hashes of a word, which no key is known for.
 */
const MORE_WALLETS = [
	"0xC5da17e956ab65A3e392e96247b70161D7C6783a",
	"0x0ab927D042b486E5eA51fE904a7199adD6E391c3",
	"0xcC4112AE56878F50A6E97f2ec048A69Db6A8Ac40",
	"0xA15539F86A672e18F5a6e00f652AD8FddE30c8f6",
	"0x6a163B3f21DB9C302aa30536aF3A104c5026C930",
	"0x7f25F7514193a6be15D9dA1758AFea5c8bdEa28b",
	"0x343FC36947CAC0Ff1Dca3520beF981380d9df955",
	"0x380e87F8e85dEd4b43bA3C400F0C6F0e241F85A4",
	"0xC2dc123abc552a4D3b7777B58eDBaa6f0A60c356",
	"0x6Ec41BA3EAde3bE20eC731531FA43A8a49EC0846",
	"0xD25C4e9981240Ba96A46A89F30ca432B8AB658cB",
	"0xA6d07feF163be3EE7D263679656fB5649dc91D4C",
	"0x893c552Be8Dd22e180D3a84EE5D4A1756C0C9634",
	"0xaBeeAE88a1eD96bFbdF2f01b32Ac97474B024894",
	"0x5d56CAe96a99f575ebF58C372eF64a3Fa46655CA",
	"0x7E57a1b2C3D4E5f60718293a4B5C6d7E8F90A1b2",
] as const;
/** A key shown in the specimen: the one every Ethereum tutorial prints, which nobody's money is behind. */
const SAMPLE_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

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

const TRAVEL: ShownWallet = {
	name: "Travel",
	network: "Base",
	address: TRAVEL_ADDRESS,
	usdc: "182.40",
	eth: "0.0031",
	read: "1 min ago, at block 23,145,880",
	backup: "saved",
	agents: [MARA, SANCHO],
};
/** Travel with its balance in the owner's currency too: a later slice's, never this build's. */
const TRAVEL_PRICED: ShownWallet = { ...TRAVEL, fiat: "≈ €171.95 at 10:42" };
const CREDITS: ShownWallet = {
	name: "API credits",
	network: "Base",
	address: CREDITS_ADDRESS,
	usdc: "24.98",
	eth: "0.0000",
	read: "1 min ago, at block 23,145,880",
	backup: "skipped",
	agents: [OCTO],
};
const TEST: ShownWallet = {
	name: "Playground",
	network: "Base Sepolia",
	testnet: true,
	address: SHOP,
	usdc: "1000.00",
	eth: "0.5000",
	read: "2 min ago, at block 18,402,113",
	backup: "saved",
	agents: [ATLAS],
};
const NEW_WALLET: ShownWallet = {
	...TRAVEL,
	name: "Travel",
	usdc: "0.00",
	eth: "0.0000",
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
		counterpart: shortAddress(STRANGER),
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
		counterpart: shortAddress(STRANGER),
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
		counterpart: "another address",
		amount: "0.0050",
		token: "ETH",
		state: "received",
		time: "16:40",
	},
];

/** When the specimen's incoming rows are read. */
const SPECIMEN_NOW = Date.UTC(2026, 10, 24, 11);

/** Money that came in, as the daemon answers it (`IncomingView`): USDC by its logs, ETH by a balance. */
const INCOMING = [
	{
		id: "0xaa:1",
		asset: "usdc",
		amount: "100000000",
		from: STRANGER,
		block: 23_145_870,
		at: SPECIMEN_NOW - 2 * 60_000,
		confirmed: false,
	},
	{
		id: "native:23145100:x",
		asset: "native",
		amount: "5000000000000000",
		block: 23_145_100,
		at: SPECIMEN_NOW - 26 * 3_600_000,
		confirmed: true,
	},
	{
		id: "0xbb:4",
		asset: "usdc",
		amount: "82400000",
		from: ANA,
		block: 22_903_412,
		at: Date.UTC(2026, 10, 2, 16, 40),
		confirmed: true,
	},
] as const;

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
			counterpart: shortAddress(STRANGER),
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

/** Each offline reason a Settings row can say, one wallet each, and a balance unread and one being read. */
export const OFFLINE_ROWS: readonly ShownWallet[] = [
	{ ...TRAVEL, offline: "locked" },
	{ ...CREDITS, name: "API credits", offline: "key_missing" },
	{ ...TEST, name: "Groceries", network: "Base", testnet: false, offline: "wrong_key" },
	{ ...TRAVEL, name: "Household", address: MORE_WALLETS[0], offline: "other_home" },
	{ ...CREDITS, name: "Side project", address: MORE_WALLETS[1], offline: "coding_agent" },
	{ ...NEW_WALLET, name: "Gifts", address: MORE_WALLETS[2], offline: "creating" },
	{ ...TRAVEL, name: "Old card", address: MORE_WALLETS[3], offline: "code" },
	{ ...TRAVEL, name: "Rent", address: MORE_WALLETS[4], offline: "denied" },
	{ ...CREDITS, name: "Bills", address: MORE_WALLETS[5], offline: "timeout" },
	{ ...TRAVEL, name: "Books", address: MORE_WALLETS[6], offline: "ambiguous" },
	{ ...CREDITS, name: "Music", address: MORE_WALLETS[7], offline: "no_keychain" },
	{ ...TRAVEL, name: "Garden", address: MORE_WALLETS[8], offline: "keychain" },
	{ ...CREDITS, name: "Lab", address: MORE_WALLETS[9], offline: "debugging" },
	{ ...TEST, name: "Local", address: MORE_WALLETS[13], offline: "chain" },
	{ ...CREDITS, name: "Taxes", address: MORE_WALLETS[14], offline: "identity" },
	{ ...TRAVEL, name: "Savings", address: MORE_WALLETS[10], usdc: null, eth: null },
	{ ...TRAVEL, name: "Just made", address: MORE_WALLETS[11], usdc: null, eth: null, reading: true },
	{ ...TRAVEL, name: "Still making", address: MORE_WALLETS[15], usdc: null, eth: null, unmade: "creating" },
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
			note="Settings → Wallets: every wallet with its balance (read, dated, never zero when unknown), the agents it serves and its one mark: Not backed up, or why it can't pay; a test network's wallet is marked Testnet. A wallet whose key isn't saved reminds once, in a toast, when it first holds more than a little (H-273). Archived wallets fold beneath; each network's RPC is a named choice."
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
								archived={[
									{ ...TEST, name: "Old travel", address: MORE_WALLETS[12], usdc: "0.00", eth: "0.0000", agents: [] },
								]}
								rpc={RPC}
							/>
						}
					/>
				</Screen>
				<Screen
					label="Each offline reason, one per wallet (signing: locked, key_missing, wrong_key, other_home; a coding agent that doesn't ask, until the signer helper, OD-11; wallet: creating; C17: code; the signer's codes: denied, timeout, ambiguous, no_keychain, keychain, debugging; the network's RPC: chain, H-187); a balance the RPC didn't give, and one being read for the first time"
					tall
				>
					<SettingsWallets wallets={<WalletsSettings wallets={OFFLINE_ROWS} rpc={RPC} />} />
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
				<Screen
					label="Changing Base's RPC: typed fresh, the one set shown only masked; a refused one says why (H-195, H-196)"
					tall
				>
					<SettingsWallets
						wallets={
							<WalletsSettings
								wallets={[TRAVEL]}
								rpc={RPC_NO_LOGS}
								editing={{
									network: "Base",
									error: "That RPC is not taken: its host name resolves to a private address",
								}}
							/>
						}
					/>
				</Screen>
				<Screen label="A network with no RPC banda can use, and no USDC: ETH alone" tall>
					<SettingsWallets
						wallets={
							<WalletsSettings
								wallets={[{ ...TEST, name: "Local", network: "Local chain", usdc: undefined, eth: "10000" }]}
								rpc={[
									...RPC,
									{
										network: "Local chain",
										url: "http://127.0.0.1:8545",
										byDefault: false,
										logs: true,
										problem: "an RPC over plain http is taken only at localhost",
									},
								]}
							/>
						}
					/>
				</Screen>
				<Screen label="No keychain this computer can reach (headless Linux)">
					<SettingsWallets wallets={<WalletsSettings wallets={[]} keychain="none" rpc={RPC} />} />
				</Screen>
				<Screen
					label="On the computer: keys without a wallet are looked for only when the owner asks (H-009, H-037)"
					tall
				>
					<SettingsWallets wallets={<WalletsSettings wallets={[TRAVEL]} rpc={RPC} onFindOrphans={() => {}} />} />
				</Screen>
				<Screen label="Looked, and the keychain holds no key without a wallet" tall>
					<SettingsWallets
						wallets={<WalletsSettings wallets={[TRAVEL]} rpc={RPC} onFindOrphans={() => {}} orphanSearch="none" />}
					/>
				</Screen>
				<Screen label="A key the keychain holds that no wallet names (H-045)" tall>
					<SettingsWallets wallets={<WalletsSettings wallets={[TRAVEL]} rpc={RPC} orphans={[STRANGER]} />} />
				</Screen>
				<Screen label="A key without a wallet in the desktop app: Export, and Delete once confirmed (H-045)" tall>
					<SettingsWallets
						wallets={
							<WalletsSettings
								wallets={[TRAVEL]}
								rpc={RPC}
								orphans={[STRANGER]}
								onExportOrphan={() => {}}
								onDeleteOrphan={() => {}}
							/>
						}
					/>
				</Screen>
				<Screen label="A network banda ships no RPC for: no way back to a default" tall>
					<SettingsWallets
						wallets={
							<WalletsSettings
								wallets={[TRAVEL]}
								rpc={[
									...RPC,
									{
										network: "Local chain",
										url: "http://127.0.0.1:8545",
										byDefault: false,
										logs: true,
										shipped: false,
									},
								]}
							/>
						}
					/>
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
				<Screen label="In a browser, not the desktop app: an extension can read the key shown next (H-272)">
					<CreateWallet name="Travel" inBrowser phone={phone} />
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
				<Screen label="Made, but its ready commit not on disk yet: the same request again finishes it and opens its key (C21)">
					<CreateWallet state="unsynced" name="Travel" phone={phone} />
				</Screen>
				<Screen label="An item already there, or a read-back that differs: nothing kept (wallet: dropped)">
					<CreateWallet state="failed" name="Travel" phone={phone} />
				</Screen>
				<Screen label="No keychain">
					<CreateWallet state="no_keychain" name="Travel" phone={phone} />
				</Screen>
				<Screen label="Refused: the keychain is locked, nothing made (no wallet: E1)">
					<CreateWallet state="refused" reason="locked" name="Travel" phone={phone} />
				</Screen>
				<Screen label="Refused: another home signs for this home's wallets, Make waits for the move (UC-21 A1)">
					<CreateWallet state="refused" reason="other_home" name="Travel" phone={phone} onMove={() => {}} />
				</Screen>
				<Screen label="Refused: another home signs, and the move is not here (a browser, a phone)">
					<CreateWallet state="refused" reason="other_home" name="Travel" phone={phone} />
				</Screen>
				<Screen label="A name another wallet has: said, and allowed (H-041)">
					<CreateWallet name="Travel" taken phone={phone} />
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
			note="Saving the key right after the wallet is made, on this computer only: why, the key shown once and copied (the clipboard clears itself), then pasted back to check. Skipped, the wallet says Not backed up. Later, only the banda app on this computer shows it again, after the computer confirms it's you; a computer that can't (no Touch ID) shows it only as the wallet is made, and every step says so (H-266)."
		>
			<div className="grid gap-6">
				<Screen label="Why it matters (wallet: ready_unsaved), in the desktop app that confirms it's you later">
					<SaveKey step="intro" wallet={NEW_WALLET} phone={phone} laterKey="here" />
				</Screen>
				<Screen label="In the desktop app on a computer that can't confirm it's you: shown only now (H-266)">
					<SaveKey step="intro" wallet={NEW_WALLET} phone={phone} laterKey="never" />
				</Screen>
				<Screen label="In a browser: its extensions can read the key, so it points to the desktop app (H-272)">
					<SaveKey step="intro" wallet={NEW_WALLET} phone={phone} inBrowser />
				</Screen>
				<Screen label="Shown">
					<SaveKey step="shown" wallet={NEW_WALLET} secret={SAMPLE_KEY} phone={phone} />
				</Screen>
				<Screen label="Copied, the clipboard counting down">
					<SaveKey step="copied" wallet={NEW_WALLET} secret={SAMPLE_KEY} clears="0:52" phone={phone} />
				</Screen>
				<Screen label="Copied in a browser: the clear needs banda open">
					<SaveKey step="copied" wallet={NEW_WALLET} secret={SAMPLE_KEY} clears="0:52" clearsWithPage phone={phone} />
				</Screen>
				<Screen label="Hidden again after 30 seconds (H-270)">
					<SaveKey step="copied" wallet={NEW_WALLET} secret={SAMPLE_KEY} hidden clears="0:21" phone={phone} />
				</Screen>
				<Screen label="Switched away: the key left the screen (H-274)">
					<SaveKey step="shown" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="The key couldn't be shown right after the wallet was made (C16: another connection, the keychain)">
					<SaveKey step="refused" wallet={NEW_WALLET} phone={phone} />
				</Screen>
				<Screen label="Back after a reload, not backed up: check a copy already saved, or skip for now">
					<SaveKey step="app_only" wallet={NEW_WALLET} phone={phone} onCheckCopy={() => {}} onSkip={() => {}} />
				</Screen>
				<Screen label="On a test network: marked beside the address (H-040)">
					<SaveKey step="intro" wallet={{ ...TEST, backup: "unsaved" }} phone={phone} />
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
				<Screen label="Later, in a browser on this computer: the desktop app shows it, on a Mac with Touch ID">
					<SaveKey step="app_only" wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="Later, in the desktop app on a computer that can't confirm it's you: never again (H-266)">
					<SaveKey step="app_only" wallet={TRAVEL} phone={phone} laterKey="never" onCheckCopy={() => {}} />
				</Screen>
				<Screen label="The key couldn't be shown, on a computer that can't confirm it's you">
					<SaveKey step="refused" wallet={NEW_WALLET} phone={phone} laterKey="never" />
				</Screen>
				<Screen label="Later, on this computer: confirm it's you first">
					<SaveKey step="confirm_host" wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="On a phone or another device: never">
					<SaveKey step="elsewhere" wallet={TRAVEL} phone={phone} />
				</Screen>
			</div>
		</Section>
	);
}

// ── A wallet ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The money that came in, as the app's activity lists it in this slice (no payment goes out yet), with a note that the
 * key was shown between them: built by the app's own `activityRows`, so ETH comes from "another address", never a
 * sender a balance cannot tell.
 */
const INCOMING_ROWS: readonly ActivityRowView[] = activityRows(
	INCOMING,
	[{ at: SPECIMEN_NOW - 3 * 3_600_000, kind: "later" }],
	SPECIMEN_NOW,
	undefined,
	false,
);

/** A wallet whose creation the keychain never finished: nothing is read for it yet. */
const UNMADE: ShownWallet = { ...TRAVEL, name: "Savings", usdc: null, eth: null, unmade: "creating" };

function WalletPageSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-page"
			note="A wallet, opened, as this build has it: its balance as the page's one figure and Receive, then Activity (what came in), Agents and Wallet. Each tab as it opens."
		>
			<div className="grid gap-6">
				<Screen label="Activity" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={<TransactionList rows={INCOMING_ROWS} more />}
						onCopyAddress={() => {}}
					/>
				</Screen>
				<Screen label="Agents" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						tab="agents"
						agents={
							<WalletAgents
								agents={[
									{ agent: MARA, on: true },
									{ agent: SANCHO, on: true },
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
						tabs={OFFERED_TABS}
						sends={false}
						tab="wallet"
						options={<WalletOptions wallet={TRAVEL} rpc={RPC[0] as RpcView} />}
					/>
				</Screen>
				<Screen label="On a test network: marked beside its address and its network (H-040)" tall>
					<WalletPage
						wallet={TEST}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						tab="wallet"
						options={<WalletOptions wallet={TEST} rpc={RPC[1] as RpcView} />}
					/>
				</Screen>
				<Screen label="Still being made (its keychain didn't answer): nothing is read, nor archived or removed" tall>
					<WalletPage
						wallet={UNMADE}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={<TransactionList rows={[]} unmade="creating" />}
						onCopyAddress={() => {}}
					/>
				</Screen>
				<Screen label="Wallet, still being made" tall>
					<WalletPage
						wallet={UNMADE}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						tab="wallet"
						options={<WalletOptions wallet={UNMADE} rpc={RPC[0] as RpcView} />}
					/>
				</Screen>
				<Screen label="Not in this home: removed, or another home's link">
					<NoWallet phone={phone} parent={{ title: "Wallets", href: "#" }} />
				</Screen>
				<Screen label="A link two wallets answer: their addresses share their ends, so it asks which">
					<WhichWallet
						phone={phone}
						parent={{ title: "Wallets", href: "#" }}
						wallets={[
							{ name: "Groceries", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", network: "Base" },
							{
								name: "Travel fund for the long summer",
								address: "0x5AaE00000000000000000000000000000000eAED",
								network: "Base Sepolia",
								testnet: true,
							},
						]}
					/>
				</Screen>
				<Screen label="Wallet, not backed up, on a phone (no key here)" tall>
					<WalletPage
						wallet={CREDITS}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						tab="wallet"
						options={<WalletOptions wallet={CREDITS} host={false} rpc={RPC[0] as RpcView} />}
					/>
				</Screen>
				<Screen label="Wallet, in the desktop app on a computer that can't confirm it's you: no Show key (H-266)" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						tab="wallet"
						options={<WalletOptions wallet={TRAVEL} shows={false} laterKey="never" rpc={RPC[0] as RpcView} />}
					/>
				</Screen>
			</div>
		</Section>
	);
}

function WalletPagePaysSection() {
	const phone = usePhone();
	const page = (wallet: ShownWallet, notices: ReactNode, extra?: { canSend?: boolean }) => (
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
			id="wallet-page-pays"
			note="A wallet that pays, as the slices that send and pay x402 will open it: Send beside Receive, its balance in the owner's currency, its payments in Activity in every state, Recipients with each one's rule per agent, and the notices only paying has."
		>
			<div className="grid gap-6">
				<Labelled label="Every state a row shows: a stored Queued reads In line, Signed reads May have sent; a payment that didn't leave is struck through">
					<TransactionList rows={EVERY_STATE} />
				</Labelled>
				<Screen label="Activity, with payments" tall>
					<WalletPage
						wallet={TRAVEL_PRICED}
						phone={phone}
						activity={<TransactionList rows={ROWS} more />}
						onCopyAddress={() => {}}
					/>
				</Screen>
				<Screen label="Recipients" tall>
					<WalletPage
						wallet={TRAVEL_PRICED}
						phone={phone}
						tab="recipients"
						recipients={<RecipientsList recipients={RECIPIENTS} />}
					/>
				</Screen>
				<Screen label="Agents, with what each paid" tall>
					<WalletPage
						wallet={TRAVEL_PRICED}
						phone={phone}
						tab="agents"
						agents={
							<WalletAgents
								agents={[
									{ agent: MARA, on: true, detail: "Paid 4 times this week" },
									{ agent: SANCHO, on: true, detail: "Paid once this week" },
									{ agent: OCTO, on: false },
								]}
							/>
						}
					/>
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
			</div>
		</Section>
	);
}

/**
 * The offline reasons a wallet's page shows as its notice here, one screen each: every reason, since a wallet's page
 * draws a notice, its body and its one fix, for each (WalletPages.tsx `Notices`), and a Settings row shows the title
 * alone (H-317).
 */
export const NOTICE_REASONS = [
	"creating",
	"locked",
	"denied",
	"timeout",
	"ambiguous",
	"no_keychain",
	"keychain",
	"debugging",
	"key_missing",
	"wrong_key",
	"other_home",
	"host_mode",
	"coding_agent",
	"identity",
	"chain",
	"code",
] as const satisfies readonly OfflineReason[];

/** The reasons whose fix is made elsewhere, shown as a browser sees them, one screen each. */
export const NOT_HERE_REASONS = [
	"key_missing",
	"wrong_key",
	"other_home",
	"chain",
] as const satisfies readonly OfflineReason[];

function WalletNoticesSection() {
	const phone = usePhone();
	const page = (wallet: ShownWallet, notices: ReactNode) => (
		<WalletPage
			wallet={wallet}
			phone={phone}
			tabs={OFFERED_TABS}
			sends={false}
			notices={notices}
			activity={<TransactionList rows={INCOMING_ROWS} />}
		/>
	);
	return (
		<Section
			id="wallet-notices"
			note="What a wallet says about itself in this build, at most one notice of each kind, each with its one fix. With code at the address, Receive gives way to the warning. The notices only paying has are with A wallet that pays."
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
				{NOTICE_REASONS.map((reason) => (
					<Screen key={reason} label={`Offline: ${OFFLINE[reason].title} (${reason})`} tall>
						{page({ ...TRAVEL, offline: reason }, <OfflineNotice reason={reason} />)}
					</Screen>
				))}
				{NOT_HERE_REASONS.map((reason) => (
					<Screen
						key={reason}
						label={`Offline, its fix not here: ${OFFLINE[reason].title} (${reason}, a browser)`}
						tall
					>
						{page({ ...TRAVEL, offline: reason }, <OfflineNotice reason={reason} actionable={false} />)}
					</Screen>
				))}
				{(["key_missing", "wrong_key"] as const).map((reason) => (
					<Screen
						key={reason}
						label={`Offline, its key never saved: ${OFFLINE[reason].title} (${reason}, backup skipped): nothing sent there can be spent`}
						tall
					>
						{page(
							{ ...TRAVEL, offline: reason, backup: "skipped" },
							<OfflineNotice reason={reason} unsaved actionable={reason === "key_missing"} />,
						)}
					</Screen>
				))}
				<Screen label="The network isn't answering: unknown, never zero" tall>
					{page({ ...TRAVEL, usdc: null, eth: null, last: "182.40 USDC at 09:12" }, undefined)}
				</Screen>
				<Screen label="Archived (wallet: archived)" tall>
					{page({ ...TRAVEL, archived: true }, <ArchivedNotice />)}
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
			note="Activity as this build has it: the money that came in, read from the chain, saying what it may miss. Payments join it with sending (A wallet that pays)."
		>
			<div className="grid gap-6">
				<Screen label="Nothing yet">
					<WalletPage
						wallet={NEW_WALLET}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={<TransactionList rows={[]} />}
						canReceive
					/>
				</Screen>
				<Screen label="Before any send exists: the money that came in alone, one row still confirming (UC-14 A3)" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={<TransactionList rows={incomingRows(INCOMING, SPECIMEN_NOW)} />}
					/>
				</Screen>
				<Screen label="Reading">
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={<TransactionList rows={[]} loading />}
					/>
				</Screen>
				<Screen label="The activity couldn't be read">
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={
							<TransactionList
								rows={[]}
								failed="banda on this computer didn't answer. Check it's still running."
								onRetry={() => {}}
							/>
						}
					/>
				</Screen>
				<Screen label="The activity couldn't be read again: the last rows, maybe out of date" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={
							<TransactionList
								rows={incomingRows(INCOMING, SPECIMEN_NOW)}
								failed="banda on this computer didn't answer. Check it's still running."
								onRetry={() => {}}
							/>
						}
					/>
				</Screen>
				<Screen label="Base set to an RPC that serves no logs: USDC in isn't listed, ETH still is" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={
							<TransactionList
								rows={incomingRows(
									INCOMING.filter((one) => one.asset === "native"),
									SPECIMEN_NOW,
								)}
								incomplete="USDC coming in isn't listed: mainnet.base.org refuses log queries. Choose another RPC in Settings → Wallets."
							/>
						}
					/>
				</Screen>
				<Screen label="Still reading back: complete since a date" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						activity={
							<TransactionList
								rows={incomingRows(INCOMING, SPECIMEN_NOW)}
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
								lookalike: `It differs from Ana's address by its last character: ${shortAddress(ANA_LOOKALIKE)} here, ${shortAddress(ANA)} for Ana.`,
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
			note="Who may read a wallet, from the wallet's side and from the agent's: switched on per agent, as any account of a connection. An agent it is on for sees its address and balance; agents sharing a wallet share its balance. Spending, with Deny rules the wallet's agents share and an Always each keeps, is in Recipients, a proposal."
		>
			<div className="@container w-full min-w-0">
				<div className="grid gap-6 @2xl:grid-cols-2">
					<Labelled label="The wallet's Agents tab, shared by two">
						<WalletAgents
							agents={[
								{ agent: MARA, on: true },
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
								{ wallet: TEST, on: false },
							]}
						/>
					</Labelled>
					<Labelled label="Mara's panel, Access: a wallet she can't use now says why, its switch still moving (H-317, UC-05)">
						<AgentWallets
							agent="Mara"
							wallets={[
								{ wallet: { ...TRAVEL, offline: "code" }, on: true },
								{ wallet: { ...CREDITS, offline: "locked" }, on: true },
							]}
						/>
					</Labelled>
					<Labelled label="Mara's panel, Access: a balance unknown says since when, and its last reading (C22, H-208)">
						<AgentWallets
							agent="Mara"
							wallets={[
								{
									wallet: {
										...TRAVEL,
										usdc: null,
										eth: null,
										unreachable: "14:02",
										last: "182.40 USDC at 09:12",
									},
									on: true,
								},
								{ wallet: { ...TEST, usdc: null, eth: null, reading: true }, on: false },
							]}
						/>
					</Labelled>
					<Labelled label="Mara's panel, Access: an archived wallet she is on for, its switch still, and why">
						<AgentWallets
							agent="Mara"
							wallets={[
								{
									wallet: { ...TRAVEL, archived: true },
									on: true,
									disabled: "Archived wallets serve no agent. Unarchive it first.",
								},
							]}
						/>
					</Labelled>
					<Labelled label="Mara's panel, Access: none yet, at the panel's width">
						<div className="w-[var(--panel-width)] max-w-full">
							<AgentWallets agent="Mara" wallets={[]} />
						</div>
					</Labelled>
					<Labelled label="A long name, at the panel's width">
						<div className="w-[var(--panel-width)] max-w-full">
							<AgentWallets agent="Bartholomew the Accountant" wallets={[]} />
						</div>
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
				<Screen label="Checking the address">
					<Receive wallet={TRAVEL} state="checking" phone={phone} />
				</Screen>
				<Screen label="Ready" tall>
					<Receive wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="Ready, on a test network: the caption marks it (H-040)" tall>
					<Receive wallet={TEST} phone={phone} />
				</Screen>
				<Screen label="Ready, its key's saving skipped: no saved copy, and Save your key (H-005)" tall>
					<Receive wallet={CREDITS} phone={phone} onSaveKey={() => {}} />
				</Screen>
				<Screen label="Before the key is saved or skipped">
					<Receive wallet={NEW_WALLET} state="save_first" phone={phone} />
				</Screen>
				<Screen label="The address has code (C17)">
					<Receive wallet={TRAVEL} state="code" phone={phone} />
				</Screen>
				<Screen label="The address has code, on the computer banda runs on: acknowledge it (H-157)">
					<Receive wallet={TRAVEL} state="code" phone={phone} onAcknowledge={() => {}} />
				</Screen>
				<Screen label="The address has code, acknowledged: the warning stays">
					<Receive wallet={TRAVEL} state="code" acknowledged phone={phone} />
				</Screen>
				<Screen label="The address couldn't be checked: never shown unchecked">
					<Receive wallet={TRAVEL} state="unchecked" phone={phone} onRetry={() => {}} />
				</Screen>
				<Screen label="The daemon answered another address than the wallet's: none shown or copied (H-261)">
					<Receive wallet={TRAVEL} state="mismatch" phone={phone} onRetry={() => {}} />
				</Screen>
				<Screen label="Archived: no address until it is unarchived, and nothing asked of banda">
					<Receive wallet={TRAVEL} state="archived" phone={phone} onUnarchive={() => {}} />
				</Screen>
				<Screen label="Being removed: no address">
					<Receive wallet={TRAVEL} state="removing" phone={phone} />
				</Screen>
				<Screen label="Still being made: no address yet">
					<Receive wallet={NEW_WALLET} state="creating" phone={phone} />
				</Screen>
				<Screen label="Its key never saved, and not checked yet in this process: never shown unchecked (H-021, H-261)">
					<Receive wallet={{ ...TRAVEL, backup: "skipped" }} state="key_unchecked" phone={phone} onRetry={() => {}} />
				</Screen>
				<Screen label="No key opens it and none was saved (key_missing or wrong_key, backup skipped): never shown">
					<Receive wallet={{ ...TRAVEL, backup: "skipped", offline: "key_missing" }} state="unopenable" phone={phone} />
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

/** A removal the daemon refused, as the app opens it from Remove: the real dialog, opened here by its button. */
function Refused({ wallet, reason }: { wallet: string; reason: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button variant="destructive" size="sm" className="self-start" onClick={() => setOpen(true)}>
				Remove
			</Button>
			<RemoveRefused wallet={wallet} reason={open ? reason : undefined} onClose={() => setOpen(false)} />
		</>
	);
}

function WalletRemoveSection() {
	return (
		<Section
			id="wallet-remove"
			note="Archive hides a wallet from agents and keeps the key; Unarchive asks nothing. Remove deletes the key, so the daemon refuses it until nothing can be lost (C17): no money at its address, no payment in flight, and a key that was saved if the address was ever shown. A refusal says the daemon's reason, and only Close. Each button opens the dialog the app opens."
		>
			<div className="grid gap-6">
				<Labelled label="Archive">
					<Confirm {...archiveWords("Travel")} action="Archive">
						<Button variant="outline" size="sm" className="self-start">
							Archive
						</Button>
					</Confirm>
				</Labelled>
				<Labelled label="Remove, its key saved">
					<Confirm {...removeWords("Old travel", "saved")} action="Remove">
						<Button variant="destructive" size="sm" className="self-start">
							Remove
						</Button>
					</Confirm>
				</Labelled>
				<Labelled label="Remove, Not backed up: no copy was saved">
					<Confirm {...removeWords("Old travel", "skipped")} action="Remove">
						<Button variant="destructive" size="sm" className="self-start">
							Remove
						</Button>
					</Confirm>
				</Labelled>
				<Labelled label="Remove, refused: the daemon's reason">
					<Refused
						wallet="Travel"
						reason="The wallet still holds funds: move them out first, by importing its key into a wallet app such as MetaMask and sending them from there."
					/>
				</Labelled>
				<Labelled label="Refused, for a name of 64 characters with no space">
					<Refused wallet={"x".repeat(64)} reason="The wallet's address was given out and its key was never saved." />
				</Labelled>
			</div>
		</Section>
	);
}

function WalletRemovingSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-removing"
			note="A removal the keychain stops stays removing until it answers, the wallet serving no agent meanwhile; money that arrives first stops it, and the wallet is archived instead (C15)."
		>
			<div className="grid gap-6">
				<Screen label="Removing: the keychain doesn't answer (wallet: removing)" tall>
					<WalletPage
						wallet={TRAVEL}
						phone={phone}
						tabs={OFFERED_TABS}
						sends={false}
						notices={<RemovingNotice />}
						activity={<TransactionList rows={INCOMING_ROWS} />}
					/>
				</Screen>
				<Labelled label="Money arrived while removing: archived instead">
					<ArchivedNotice />
				</Labelled>
			</div>
		</Section>
	);
}

function WalletRestoreSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-restore"
			note="Restore key: the copy the owner saved, pasted in banda's desktop app on the computer banda runs on; it must open the address, and it goes to the signer, never to the daemon (C20)."
		>
			<div className="grid gap-6">
				<Screen label="Restore key (signing: key_missing)">
					<RestoreKey wallet={TRAVEL} phone={phone} />
				</Screen>
				<Screen label="A key that opens another address: nothing changes">
					<RestoreKey wallet={TRAVEL} state="wrong" phone={phone} />
				</Screen>
				<Screen label="A copy that is no key's text (not_a_key): nothing changes">
					<RestoreKey wallet={TRAVEL} state="not_a_key" phone={phone} />
				</Screen>
				<Screen label="Restored: payments in line go out">
					<RestoreKey wallet={TRAVEL} state="restored" phone={phone} />
				</Screen>
				<Screen label="In a browser or on a phone: only the desktop app takes a key">
					<RestoreKey wallet={TRAVEL} state="elsewhere" phone={phone} />
				</Screen>
			</div>
		</Section>
	);
}

function WalletMoveSection() {
	const phone = usePhone();
	return (
		<Section
			id="wallet-move"
			note="Move signing here: one signing home per wallet, moved on the computer banda runs on once each key proves it opens its wallet."
		>
			<Screen label="Move signing here (signing: other_home)">
				<MoveSigning wallets={[TRAVEL, CREDITS]} phone={phone} />
			</Screen>
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
								lookalike: `It differs from Ana's address by its last character: ${shortAddress(ANA_LOOKALIKE)} here, ${shortAddress(ANA)} for Ana.`,
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
			<WalletPagePaysSection />
			<WalletNoticesSection />
			<WalletActivitySection />
			<WalletPaymentSection />
			<WalletRecipientsSection />
			<WalletAgentsSection />
			<WalletReceiveSection />
			<WalletSendSection />
			<WalletRemoveSection />
			<WalletRemovingSection />
			<WalletRestoreSection />
			<WalletMoveSection />
			<PaymentCardsSection />
			<PaymentRecordsSection />
		</>
	);
}
