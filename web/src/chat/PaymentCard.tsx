/**
 * A payment in the chat (proposal: docs/wallets.md, not wired yet). The daemon draws it, plain, whoever the agent is.
 * When the recipient's rule is Ask, or the recipient is new, the card asks: Pay (this once), Always pay (sets Always for
 * this agent, up to what's in the wallet), Don't pay (this once) and Never pay (sets Deny for the wallet), with a field
 * to name a new recipient first. Nothing in the payment is editable: it runs as stored or not at all. When the rule is
 * Always the card is a record, and follows the payment to the network's last word. A refusal that needs no answer is a
 * line, not a card.
 */
import {
	CheckIcon,
	CircleSlashIcon,
	ClockIcon,
	GlobeIcon,
	MonitorIcon,
	TriangleAlertIcon,
	UserRoundIcon,
	XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { shortAddress } from "../../../src/wallet/label.ts";
import { Tile } from "./Cards.tsx";
import { type Network, type PaymentState, PaymentStatus, type Token, WalletNotice } from "./Wallets.tsx";

export type PaymentRecipient = {
	/** The owner's name for it; absent for a recipient nobody has named. */
	readonly name?: string | undefined;
	/** The agent's suggestion for a new recipient's name: a suggestion in the field, never the name. */
	readonly suggested?: string | undefined;
	/** An address, in full; for x402, the endpoint's origin and path as the proxy saw it. */
	readonly identity: string;
	readonly network: Network;
	/** For x402: who the endpoint asks to be paid. */
	readonly payTo?: string | undefined;
	/** New to this wallet: the card names it, and asks however the rules stand. */
	readonly isNew?: boolean | undefined;
	/** One character off a recipient the owner has: said in full, both addresses shown. */
	readonly lookalike?: string | undefined;
};

/** How a payment card stands: open, or answered and following the payment, or closed with no payment. */
export type PaymentCardState =
	| { readonly kind: "open" }
	/** Answered on a phone for a recipient new to the computer: the computer confirms it. */
	| { readonly kind: "host" }
	| {
			readonly kind: "paid";
			readonly answer: "once" | "always";
			readonly status: PaymentState;
			readonly detail?: string;
	  }
	| { readonly kind: "declined"; readonly never: boolean }
	| { readonly kind: "closed"; readonly words: string; readonly icon: "clock" | "slash" | "device" };

export type PaymentCardProps = {
	readonly agent: string;
	readonly kind: "transfer" | "x402";
	readonly amount: string;
	readonly token: Token;
	/** The owner's currency, an estimate, dated: "≈ €23.10 at 10:42". */
	readonly fiat?: string | undefined;
	readonly recipient: PaymentRecipient;
	readonly wallet: { readonly name: string; readonly after: string };
	/** Why the agent says it pays, in its words. */
	readonly reason?: string | undefined;
	/** Another agent of the wallet already pays this recipient always: the card offers the same for this one. */
	readonly sharedWith?: string | undefined;
	/** Why it asks again: an approval too old when its turn came, or a nonce spent outside banda meanwhile. */
	readonly again?: string | undefined;
	readonly state?: PaymentCardState;
	/** On a paired phone: Pay and Always pay on a new recipient wait for the computer. */
	readonly phone?: boolean;
};

/** The recipient as the card shows it: its name if it has one, and always what it is. */
function To({ recipient, kind }: { recipient: PaymentRecipient; kind: "transfer" | "x402" }) {
	const Icon = kind === "x402" ? GlobeIcon : UserRoundIcon;
	return (
		<div className="flex gap-3 rounded-field bg-paper-2 px-3.5 py-2.5">
			<Icon className="mt-0.5 size-4 shrink-0 text-ink-2" />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				{recipient.name === undefined ? (
					<span className="text-ui text-ink-2">{recipient.isNew === true ? "New recipient" : "No name"}</span>
				) : (
					<span className="text-ui font-medium text-ink">{recipient.name}</span>
				)}
				<span className="font-code text-meta text-ink [overflow-wrap:anywhere]">{recipient.identity}</span>
				{recipient.payTo === undefined ? null : (
					<span className="text-meta text-ink-2">
						pays <span className="font-code">{shortAddress(recipient.payTo)}</span>
					</span>
				)}
				<span className="text-meta text-ink-2">on {recipient.network}</span>
			</span>
		</div>
	);
}

/** As tall as the buttons it replaces, so the card keeps its height when it settles. */
function Settled({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
	return (
		<span className={cn("flex min-h-9 items-center gap-1.5 text-ui text-ink-2", className)}>
			{icon}
			<span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
		</span>
	);
}

export function PaymentCard({
	agent,
	kind,
	amount,
	token,
	fiat,
	recipient,
	wallet,
	reason,
	sharedWith,
	again,
	state = { kind: "open" },
	phone = false,
}: PaymentCardProps) {
	const name =
		recipient.name ?? recipient.suggested ?? (kind === "x402" ? "this endpoint" : shortAddress(recipient.identity));
	const what = `Pay ${recipient.name ?? (kind === "x402" ? recipient.identity.split("/")[0] : shortAddress(recipient.identity))} ${amount} ${token}`;
	return (
		<Tile className="flex flex-col gap-3 p-4">
			<span className="flex flex-col gap-0.5">
				<span className="text-meta text-ink-2">{agent} asks to</span>
				<span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">{what}</span>
				<span className="text-meta text-ink-2">
					{fiat === undefined ? null : `${fiat} · `}from {wallet.name}, {wallet.after} left after
				</span>
			</span>
			{again === undefined ? null : (
				<p className="flex items-start gap-1.5 text-ui text-ink">
					<ClockIcon className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
					{again}
				</p>
			)}
			<To recipient={recipient} kind={kind} />
			{recipient.lookalike === undefined ? null : (
				<WalletNotice
					icon={TriangleAlertIcon}
					tone="danger"
					title="Looks like a recipient you have"
					body={recipient.lookalike}
				/>
			)}
			{reason === undefined ? null : (
				<blockquote className="flex flex-col gap-0.5 border-l-0 text-body text-ink">
					<span className="text-meta text-ink-2">{agent} says</span>
					<q className="[overflow-wrap:anywhere]">{reason}</q>
				</blockquote>
			)}
			{state.kind === "open" ? (
				<>
					{recipient.isNew === true && recipient.name === undefined ? (
						// biome-ignore lint/a11y/noLabelWithoutControl: the input inside is the control
						<label className="flex flex-col gap-1.5">
							<span className="text-ui font-medium text-ink">Name this recipient</span>
							<Input defaultValue={recipient.suggested ?? ""} placeholder="Ana, Weather API…" />
							{recipient.suggested === undefined ? null : (
								<span className="text-meta text-ink-2">{agent} suggested the name. It's yours to change.</span>
							)}
						</label>
					) : null}
					<span className="flex flex-wrap items-center gap-2">
						<Button>Pay</Button>
						<Button variant="outline" className="h-auto min-h-9 max-w-full shrink py-1.5 text-left whitespace-normal">
							{sharedWith === undefined
								? `Always pay ${name}, up to what's in the wallet`
								: `Always pay ${name} for ${agent} too`}
						</Button>
					</span>
					<span className="flex flex-wrap items-center gap-2">
						<Button variant="ghost">Don't pay</Button>
						<Button variant="destructive">Never pay {name}</Button>
					</span>
					{sharedWith === undefined ? null : (
						<span className="text-meta text-ink-2">
							{sharedWith} already pays {name} without asking, from the same wallet.
						</span>
					)}
					{phone && recipient.isNew === true ? (
						<span className="flex items-center gap-1.5 text-meta text-ink-2">
							<MonitorIcon className="size-3 shrink-0" />
							{name} is new, so Pay and Always pay wait for your computer to confirm.
						</span>
					) : null}
				</>
			) : state.kind === "host" ? (
				<Settled icon={<MonitorIcon className="size-4 shrink-0" />}>
					You said pay on your phone. Waiting for your computer to confirm {name}.
				</Settled>
			) : state.kind === "paid" ? (
				<span className="flex min-h-9 flex-col justify-center gap-0.5">
					<span className="flex items-center gap-1.5 text-ui text-ink">
						<CheckIcon className="size-4 shrink-0 text-alive" />
						{state.answer === "once" ? "You said pay, this once" : `You said always pay ${name}`}
					</span>
					<span className="pl-5.5">
						<PaymentStatus state={state.status} detail={state.detail} />
					</span>
				</span>
			) : state.kind === "declined" ? (
				<Settled
					icon={state.never ? <CircleSlashIcon className="size-4 shrink-0" /> : <XIcon className="size-4 shrink-0" />}
				>
					{state.never ? `You said never: ${agent} can't pay ${name} again` : "You said no: didn't pay"}
				</Settled>
			) : (
				<Settled
					icon={
						state.icon === "clock" ? (
							<ClockIcon className="size-4 shrink-0" />
						) : state.icon === "device" ? (
							<MonitorIcon className="size-4 shrink-0" />
						) : (
							<CircleSlashIcon className="size-4 shrink-0" />
						)
					}
				>
					{state.words}
				</Settled>
			)}
		</Tile>
	);
}

/**
 * A payment that needed no answer (its recipient is Always, or the owner's own Send), as a record in the chat: who paid
 * whom, how much, and its state, followed to the network's last word.
 */
export function PaymentRecord({
	agent,
	kind = "transfer",
	amount,
	token,
	to,
	wallet,
	status,
	detail,
	note,
}: {
	agent: string;
	kind?: "transfer" | "x402";
	amount: string;
	token: Token;
	to: string;
	wallet: string;
	status: PaymentState;
	detail?: string | undefined;
	/** What the state means here: a failure's fee, a restore. */
	note?: string | undefined;
}) {
	return (
		<Tile className="flex flex-col gap-2 p-4">
			<span className="flex flex-col gap-0.5">
				<span className="text-meta text-ink-2">
					{agent} {kind === "x402" ? "paid for a request" : "paid"} · Always
				</span>
				<span className="text-body font-semibold text-ink [overflow-wrap:anywhere]">
					{amount} {token} to {to}
				</span>
				<span className="text-meta text-ink-2">from {wallet}</span>
			</span>
			<PaymentStatus state={status} detail={detail} />
			{note === undefined ? null : <p className="text-ui text-ink-2">{note}</p>}
		</Tile>
	);
}
