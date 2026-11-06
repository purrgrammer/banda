/**
 * The phone's pairing screen (the native shell, before it is a device): scan the code Settings → Devices shows on the
 * owner's computer, under a name for this phone, then wait there for Approve. A link the phone was opened with pairs
 * without the camera. The owner's computer is the one place a phone becomes a device; this screen only asks.
 */
import { QrCodeIcon, SmartphoneIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fingerprint, type PairingStep } from "../lib/pairing.ts";

export type PairPhoneActions = {
	readonly onScan?: ((name: string) => void) | undefined;
	readonly onPairLink?: ((name: string) => void) | undefined;
	readonly onConfirm?: (() => void) | undefined;
	readonly onAgain?: (() => void) | undefined;
	readonly onRetry?: (() => void) | undefined;
};

function Frame({ children }: { children: ReactNode }) {
	return (
		<main className="flex min-h-svh flex-col items-center justify-center bg-paper px-4 py-10 text-ink">
			<div className="flex w-full max-w-sm flex-col gap-6">{children}</div>
		</main>
	);
}

/** A fingerprint, as both screens show it. */
function Code({ label, id }: { label: string; id: string | undefined }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-meta text-ink-2">{label}</dt>
			<dd className="font-mono text-body font-medium tracking-wide text-ink">
				{id === undefined ? "…" : fingerprint(id)}
			</dd>
		</div>
	);
}

function Heading({ title, note }: { title: string; note: ReactNode }) {
	return (
		<header className="flex flex-col gap-3">
			<span className="flex size-11 items-center justify-center rounded-tile bg-paper-3">
				<SmartphoneIcon className="size-5 text-ink-2" />
			</span>
			<h1 className="text-heading font-semibold">{title}</h1>
			<p className="text-body text-ink-2">{note}</p>
		</header>
	);
}

export function PairPhone({ step, ...act }: { step: PairingStep } & PairPhoneActions) {
	if (step.step === "checking" || step.step === "paired")
		return (
			<Frame>
				<p className="flex items-center gap-2 text-ui text-ink-2">
					<Spinner /> Reaching your computer…
				</p>
			</Frame>
		);
	if (step.step === "unreachable")
		return (
			<Frame>
				<Heading
					title="Can’t reach your computer"
					note="This phone reaches banda from anywhere while your computer is on and banda is running there."
				/>
				<div className="flex flex-col gap-2">
					<Button size="lg" onClick={act.onRetry}>
						Try again
					</Button>
					<Button size="lg" variant="ghost" onClick={act.onAgain}>
						Pair with a new code
					</Button>
				</div>
			</Frame>
		);
	if (step.step === "confirm")
		return (
			<Frame>
				<Heading
					title="Is this your computer?"
					note="Compare this code with Settings → Devices on your computer. Continue only if they match."
				/>
				<dl aria-label="Computer to pair with">
					<Code label="Computer’s code" id={step.computer} />
				</dl>
				<Button size="lg" onClick={act.onConfirm}>
					The codes match · Pair
				</Button>
				<Button size="lg" variant="ghost" onClick={act.onAgain}>
					Cancel
				</Button>
			</Frame>
		);

	if (step.step === "waiting" || step.step === "asking")
		return (
			<Frame>
				<Heading
					title={step.step === "asking" ? "Asking your computer…" : "Waiting for your computer"}
					note={
						<>
							On your computer, in Settings → Devices, check that the request for{" "}
							<span className="font-medium text-ink">“{step.name}”</span> shows this phone’s code, then approve it. This
							phone opens banda as soon as you do.
						</>
					}
				/>
				<dl className="flex flex-col gap-3 rounded-tile bg-paper-2 px-3.5 py-3" aria-label="Codes to compare">
					<Code label="This phone’s code" id={step.device} />
					<Code label="Your computer’s code" id={step.computer} />
				</dl>
				<p className="flex items-center gap-2 text-ui text-ink-2" aria-live="polite">
					<Spinner /> {step.step === "asking" ? "Sending the request" : "Waiting for approval"}
				</p>
				{step.step === "waiting" ? (
					<Button size="lg" variant="ghost" onClick={act.onAgain}>
						Start over
					</Button>
				) : null}
			</Frame>
		);
	return <Scan key={step.name} step={step} act={act} />;
}

function Scan({ step, act }: { step: Extract<PairingStep, { step: "scan" }>; act: PairPhoneActions }) {
	const [name, setName] = useState(step.name);
	const id = useId();
	const trimmed = name.trim();
	const linked = step.link !== undefined;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (trimmed === "") return;
		if (linked) act.onPairLink?.(trimmed);
		else act.onScan?.(trimmed);
	};
	return (
		<Frame>
			<Heading
				title="Pair this phone with banda"
				note={
					linked
						? "You opened a pairing code. Check which computer it names, then approve this phone there."
						: "On your computer, open banda, then Settings → Devices → Pair a phone, and scan the code it shows."
				}
			/>
			<form onSubmit={submit} className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<label htmlFor={id} className="text-ui font-medium text-ink">
						This phone’s name
					</label>
					<Input
						id={id}
						value={name}
						maxLength={64}
						aria-describedby={`${id}-note`}
						onChange={(event) => setName(event.target.value)}
					/>
					<span id={`${id}-note`} className="text-meta text-ink-2">
						Your computer lists this phone by it. You can change it there.
					</span>
				</div>
				{step.note === undefined ? null : (
					<p role="alert" className="rounded-tile bg-paper-2 px-3.5 py-3 text-ui text-ink">
						{step.note}
					</p>
				)}
				<Button type="submit" size="lg" disabled={trimmed === ""}>
					{linked ? null : <QrCodeIcon />}
					{linked ? "Pair with this code" : "Scan the code"}
				</Button>
			</form>
		</Frame>
	);
}
