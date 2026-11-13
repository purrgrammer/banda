/**
 * Settings' devices: the phones that reach banda from anywhere, as the owner. "Pair a phone" shows a code to scan,
 * live for ten minutes; the phone that scans it asks to pair and waits here for the owner's Approve or Deny. Each paired
 * device is the owner's to rename or revoke (asked first). What identifies a device and how it reaches this computer
 * stays behind Details. On a device itself (`here` false) the list is all there is: the daemon pairs, renames and
 * revokes only for the computer it runs on, so a phone cannot mint access that outlives its own.
 */
import { CheckIcon, ChevronDownIcon, CopyIcon, PencilIcon, PlusIcon, SmartphoneIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import type { DevicesView, DeviceView, PairingRequestView } from "../../../src/server/api.ts";
import { QrCode } from "../components/QrCode.tsx";
import { fingerprint } from "../lib/pairing.ts";
import { Confirm } from "./Confirm.tsx";
import { Block, RowOf, Rows } from "./Settings.tsx";

/** The invite on screen: what its code carries, and when it stops working. */
export type ShownInvite = { readonly pairing: string; readonly expires: number };

export type DevicesActions = {
	readonly onPair?: (() => void) | undefined;
	readonly onCancel?: (() => void) | undefined;
	readonly onApprove?: ((id: string, name: string) => void) | undefined;
	readonly onDeny?: ((id: string) => void) | undefined;
	readonly onRename?: ((id: string, name: string) => void) | undefined;
	readonly onRevoke?: ((id: string) => void) | undefined;
};

/** The time now, a second at a time while `on`. */
function useNow(on: boolean, fixed?: number): number {
	const [now, setNow] = useState(() => fixed ?? Date.now());
	useEffect(() => {
		if (!on || fixed !== undefined) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [on, fixed]);
	// When a code first appears, do not render one frame against the clock from before the async response arrived.
	return fixed ?? (on ? Date.now() : now);
}

/** Minutes and seconds left, as a clock reads: 9:05. */
export const countdown = (ms: number) => {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const day = (at: number) => new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });

export function DevicesSettings({
	devices,
	invite,
	making = false,
	now: fixed,
	details: open,
	here = true,
	...given
}: {
	/** As the daemon last said; undefined until read. */
	devices: DevicesView | undefined;
	/** The code on screen, until it is used, cancelled or expires. */
	invite?: ShownInvite | undefined;
	/** An invite is being made. */
	making?: boolean;
	/** A fixed clock, for the specimen. */
	now?: number;
	/** Details open from the start, for the specimen. */
	details?: boolean;
	/** On the computer banda runs on, where devices are paired, renamed and revoked; false on a device. */
	here?: boolean;
} & DevicesActions) {
	const act: DevicesActions = here ? given : {};
	const requests = here ? (devices?.requests ?? []) : [];
	const now = useNow(invite !== undefined || requests.length > 0, fixed);
	const off = devices !== undefined && (devices.remote === "off" || devices.remote === "unavailable");
	const list = devices?.devices ?? [];
	const expired = invite !== undefined && invite.expires <= now;
	return (
		<>
			<Block
				title="Devices"
				note={
					here
						? "Phones you pair reach banda from anywhere, as you: your chats, your agents, your approvals."
						: "Phones you pair reach banda from anywhere, as you. Pair, rename and revoke them in banda on your computer."
				}
			>
				{requests.length > 0 ? (
					<Rows>
						{requests.map((request) => (
							<RequestRow key={request.id} request={request} now={now} act={act} />
						))}
					</Rows>
				) : here && invite !== undefined ? (
					<Pairing invite={invite} expired={expired} now={now} computer={devices?.endpoint?.id} act={act} />
				) : null}
				<Rows>
					{list.map((device) => (
						<DeviceRow key={device.id} device={device} act={act} here={here} />
					))}
					{!here && devices === undefined ? <RowOf title={<span className="text-ink-2">Looking…</span>} /> : null}
					{!here ? null : (
						<RowOf
							title={
								<span className="text-ink-2">
									{devices === undefined
										? "Looking…"
										: devices.remote === "unavailable"
											? "Reaching banda from your phone isn’t available on this computer yet"
											: off
												? "Reaching banda from your phone is off on this computer"
												: list.length === 0
													? "No phone paired yet"
													: "Another phone"}
								</span>
							}
							end={
								<Button
									variant="outline"
									size="xs"
									disabled={devices === undefined || off || making || (invite !== undefined && !expired)}
									onClick={act.onPair}
								>
									<PlusIcon />
									Pair a phone
								</Button>
							}
						/>
					)}
				</Rows>
			</Block>
			{devices === undefined ? null : <Details devices={devices} invite={invite} open={open} />}
		</>
	);
}

/** The code to scan, and how long it lasts; once it expired, a way to make a new one. */
function Pairing({
	invite,
	expired,
	now,
	computer,
	act,
}: {
	invite: ShownInvite;
	expired: boolean;
	now: number;
	/** This computer's endpoint id, which the phone shows too while it asks. */
	computer: string | undefined;
	act: DevicesActions;
}) {
	return (
		<div className="@container rounded-tile border border-line-soft p-4">
			<div className="flex flex-col items-center gap-4 @md:flex-row @md:items-start">
				<div className="relative shrink-0">
					<QrCode
						value={invite.pairing}
						label="Code to scan with banda on your phone"
						className={cn("size-44 p-1.5", expired && "opacity-15")}
					/>
					{expired ? (
						<span className="absolute inset-0 flex items-center justify-center text-ui font-medium text-ink">
							Expired
						</span>
					) : null}
				</div>
				<div className="flex min-w-0 flex-1 flex-col gap-3 self-stretch">
					<div className="flex flex-col gap-1">
						<p className="text-body font-semibold text-ink">{expired ? "This code expired" : "Scan with your phone"}</p>
						<p className="text-ui text-ink-2">
							{expired
								? "Codes last ten minutes. Make a new one when your phone is ready."
								: "Open banda on your phone and scan this code. It asks to pair here, and you approve it."}
						</p>
					</div>
					{expired || computer === undefined ? null : (
						<p className="text-meta text-ink-2">
							This computer’s code:{" "}
							<span className="font-mono font-medium tracking-wide whitespace-nowrap text-ink">
								{fingerprint(computer)}
							</span>
						</p>
					)}
					{expired ? null : (
						<p className="text-meta text-ink-2" aria-live="off">
							Works for <span className="font-medium text-ink tabular-nums">{countdown(invite.expires - now)}</span>,
							once
						</p>
					)}
					<div className="mt-auto flex gap-2">
						{expired ? (
							<Button size="sm" onClick={act.onPair}>
								Make a new code
							</Button>
						) : null}
						<Button variant="ghost" size="sm" onClick={act.onCancel}>
							{expired ? "Close" : "Cancel"}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * A phone asking to pair: the name it asked for, the owner's to change, then Approve or Deny. Anyone who saw the code
 * can ask under any name, so Approve waits until the owner says the phone in their hand shows this request's code.
 */
function RequestRow({ request, now, act }: { request: PairingRequestView; now: number; act: DevicesActions }) {
	const [name, setName] = useState(request.name);
	const [matched, setMatched] = useState(false);
	const trimmed = name.trim();
	const matchId = `match-${request.id}`;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (trimmed !== "" && matched) act.onApprove?.(request.id, trimmed);
	};
	return (
		<form onSubmit={submit} className="flex flex-col gap-3 p-3.5" aria-label={`${request.name} asks to pair`}>
			<div className="flex items-center gap-3">
				<Lead />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="text-ui font-medium text-ink">“{request.name}” asks to pair</span>
					<span className="text-meta text-ink-2">
						Approve only a phone you are holding. Waits {countdown(request.expires - now)} more.
					</span>
				</span>
			</div>
			<div className="flex flex-col gap-2 rounded-tile bg-paper-2 px-3.5 py-3">
				<p className="text-meta text-ink-2">
					Its code:{" "}
					<span className="font-mono text-body font-medium tracking-wide whitespace-nowrap text-ink">
						{fingerprint(request.id)}
					</span>
				</p>
				<div className="flex items-center gap-2">
					<Checkbox id={matchId} checked={matched} onCheckedChange={(checked) => setMatched(checked === true)} />
					<label htmlFor={matchId} className="text-ui text-ink">
						My phone shows this code
					</label>
				</div>
			</div>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<Input
					aria-label="Name it"
					value={name}
					maxLength={64}
					onChange={(event) => setName(event.target.value)}
					className="sm:flex-1"
				/>
				<div className="flex gap-2">
					<Button type="submit" size="sm" disabled={trimmed === "" || !matched} className="flex-1 sm:flex-none">
						Approve
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="flex-1 sm:flex-none"
						onClick={() => act.onDeny?.(request.id)}
					>
						Deny
					</Button>
				</div>
			</div>
		</form>
	);
}

const Lead = ({ connected = false, revoked = false }: { connected?: boolean; revoked?: boolean }) => (
	<span className="relative flex size-8 shrink-0 items-center justify-center rounded-field bg-paper-3">
		<SmartphoneIcon className={cn("size-4 text-ink-2", revoked && "opacity-50")} />
		{connected ? (
			<span
				aria-hidden="true"
				className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-paper bg-alive"
			/>
		) : null}
	</span>
);

/** A paired device: renamed in place, revoked after a confirm. A revoked one stays listed, with nothing to do. */
function DeviceRow({ device, act, here }: { device: DeviceView; act: DevicesActions; here: boolean }) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(device.name);
	const revoked = device.revoked !== undefined;
	const save = (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (trimmed !== "" && trimmed !== device.name) act.onRename?.(device.id, trimmed);
		setEditing(false);
	};
	if (editing)
		return (
			<form onSubmit={save} className="flex min-h-12 flex-wrap items-center gap-2 px-3.5 py-2.5">
				<Lead connected={device.connected} />
				<Input
					aria-label={`New name for ${device.name}`}
					value={name}
					maxLength={64}
					autoFocus
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") setEditing(false);
					}}
					className="min-w-40 flex-1"
				/>
				<Button type="submit" size="xs" disabled={name.trim() === ""}>
					Save
				</Button>
				<Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
					Cancel
				</Button>
			</form>
		);
	return (
		<RowOf
			className={cn(revoked && "text-ink-2")}
			lead={<Lead connected={device.connected} revoked={revoked} />}
			title={<span className={cn(revoked && "text-ink-2 line-through decoration-ink-2/40")}>{device.name}</span>}
			detail={
				revoked
					? `Revoked ${day(device.revoked as number)}: it can't reach banda`
					: device.connected
						? "Connected now"
						: `Paired ${day(device.paired)}`
			}
			end={
				revoked || !here ? null : (
					<span className="flex shrink-0 gap-1">
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={`Rename ${device.name}`}
							onClick={() => {
								setName(device.name);
								setEditing(true);
							}}
						>
							<PencilIcon />
						</Button>
						<Confirm
							title={`Revoke ${device.name}?`}
							body="It stops reaching banda at once, and whatever it has open closes. To use it again, pair it again."
							action="Revoke"
							keep={`Keep ${device.name}`}
							onConfirm={act.onRevoke === undefined ? undefined : () => act.onRevoke?.(device.id)}
						>
							<Button variant="destructive" size="xs" aria-label={`Revoke ${device.name}`}>
								Revoke
							</Button>
						</Confirm>
					</span>
				)
			}
		/>
	);
}

/** What identifies this computer and each device, and how phones reach it: for the curious, folded away. */
function Details({
	devices,
	invite,
	open,
}: {
	devices: DevicesView;
	invite: ShownInvite | undefined;
	open?: boolean | undefined;
}) {
	const line = (label: string, value: ReactNode, key: string = label) => (
		<div key={key} className="flex flex-col gap-0.5">
			<dt className="text-meta text-ink-2">{label}</dt>
			<dd className="text-meta text-ink">{value}</dd>
		</div>
	);
	const id = (label: string, value: string, key: string = label) => line(label, <Key value={value} />, key);
	return (
		<Collapsible defaultOpen={open} className="group/details flex flex-col gap-3">
			<CollapsibleTrigger asChild>
				<Button variant="ghost" size="xs" className="self-start text-ink-2">
					Details
					<ChevronDownIcon className="transition-transform group-data-[state=open]/details:rotate-180" />
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<dl className="flex flex-col gap-3 rounded-tile border border-line-soft p-3.5">
					{devices.endpoint === null ? (
						line(
							"Remote reach",
							devices.remote === "off"
								? "off (config.json remote.reach)"
								: devices.remote === "unavailable"
									? "not available: Iroh has no build for this computer"
									: "starts when you pair a phone",
						)
					) : (
						<>
							{id("This computer's endpoint", devices.endpoint.id)}
							{line(
								"Reached",
								devices.endpoint.reach === "n0" ? "through n0's public relays, or directly" : "on loopback only",
							)}
						</>
					)}
					{invite === undefined ? null : line("Pairing link", <CopyText text={invite.pairing} label="Copy link" />)}
					{devices.devices.map((device) => id(device.name, device.id, device.id))}
					{devices.requests.map((request) => id(`${request.name} (asking)`, request.id, `asking ${request.id}`))}
				</dl>
			</CollapsibleContent>
		</Collapsible>
	);
}

/** A long id said short, its ends kept: the whole on a tap, and a copy. */
function Key({ value }: { value: string }) {
	const [whole, setWhole] = useState(false);
	const short = value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
	return (
		<span className="flex min-w-0 items-center gap-1">
			<button
				type="button"
				aria-expanded={whole}
				aria-label={whole ? value : `${short}, show all`}
				title={whole ? undefined : value}
				onClick={() => setWhole(!whole)}
				className={cn(
					"-mx-1 min-w-0 rounded-field px-1 py-0.5 text-left font-mono hover:bg-paper-3",
					whole ? "break-all" : "truncate",
				)}
			>
				{whole ? value : short}
			</button>
			<CopyText text={value} label="Copy" icon />
		</span>
	);
}

/** Copies its text; says Copied for a moment, or Couldn't copy when the browser refuses. */
function CopyText({ text, label, icon = false }: { text: string; label: string; icon?: boolean }) {
	const [said, setSaid] = useState<"Copied" | "Couldn't copy" | undefined>(undefined);
	useEffect(() => {
		if (said === undefined) return;
		const timer = setTimeout(() => setSaid(undefined), 1500);
		return () => clearTimeout(timer);
	}, [said]);
	const copy = () =>
		void navigator.clipboard.writeText(text).then(
			() => setSaid("Copied"),
			() => setSaid("Couldn't copy"),
		);
	const words = said ?? label;
	return icon ? (
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label={words}
			title={words}
			data-copy={text}
			onClick={copy}
			className="shrink-0 text-ink-2"
		>
			{said === "Copied" ? <CheckIcon /> : <CopyIcon />}
		</Button>
	) : (
		<Button variant="outline" size="xs" data-copy={text} onClick={copy} className="self-start">
			{said === "Copied" ? <CheckIcon /> : <CopyIcon />}
			{words}
		</Button>
	);
}
