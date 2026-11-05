/**
 * First run: the first agent, and the model providers to pick from. The one picked signs the owner in, or takes a key
 * where it has no sign-in; one screen, no other step. Then the chat opens with the agent's first words.
 */
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { Face } from "./Face.tsx";
import { ProviderKeyForm } from "./ProviderKeyForm.tsx";

const FIRST_FACE = defaultAvatarFace();

export type ProviderChoice = {
	readonly id: string;
	readonly name: string;
	/** Signs in, or takes a key. */
	readonly by: "sign-in" | "key";
	readonly note?: string | undefined;
	/** Where a key is made, for a provider that takes one. */
	readonly keyUrl?: string | undefined;
};

export function FirstRun({
	providers,
	open,
	waiting,
	error,
	onPick,
	onKey,
}: {
	providers: readonly ProviderChoice[];
	/** The provider whose key form is open. */
	open?: string | undefined;
	/** A sign-in under way at this provider, in its own tab. */
	waiting?: string | undefined;
	/** What went wrong, who, what and the fix, in words. */
	error?: string | undefined;
	onPick?: (id: string) => void;
	onKey?: (id: string, key: string) => void;
}) {
	return (
		<div className="flex h-full flex-col items-center overflow-y-auto bg-paper px-4 py-12">
			<div className="flex w-full max-w-sm shrink-0 flex-col items-center gap-3 text-center">
				<Face face={FIRST_FACE} name="Sancho" size="hero" />
				<h1 className="mt-2 text-display font-semibold text-ink">Sancho</h1>
				<p className="text-body text-ink-2">
					I'm the first of your band. Pick the model I think with, and we can start.
				</p>
			</div>
			<ul className="mt-8 flex w-full max-w-sm shrink-0 flex-col divide-y divide-line-soft overflow-y-auto overscroll-contain max-h-[min(24rem,50dvh)] rounded-tile border border-line-soft">
				{providers.map((provider) => (
					<li key={provider.id}>
						<button
							type="button"
							aria-expanded={provider.by === "key" ? provider.id === open : undefined}
							onClick={() => onPick?.(provider.id)}
							className={cn(
								"flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-paper-2",
								provider.id === open && "bg-paper-2",
							)}
						>
							<img src={`/providers/${provider.id}.svg`} alt="" className="size-6 shrink-0 dark:invert" />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-ui font-medium text-ink">{provider.name}</span>
								<span className="text-meta text-ink-2">
									{provider.id === waiting
										? "Finish signing in in the other tab…"
										: (provider.note ?? (provider.by === "sign-in" ? "Sign in with your account" : "Use a key"))}
								</span>
							</span>
							<ChevronRightIcon className={cn("size-4 text-ink-3", provider.id === open && "rotate-90")} />
						</button>
						{provider.id === open ? (
							<ProviderKeyForm provider={provider} className="bg-paper-2 px-3.5 pb-3.5" onKey={onKey} />
						) : null}
					</li>
				))}
			</ul>
			{error === undefined ? null : (
				<p role="alert" className="mt-4 max-w-sm text-center text-ui text-danger">
					{error}
				</p>
			)}
			<p className="mt-4 max-w-sm text-center text-meta text-ink-2">
				Your provider sees what you ask. You can change it later in Settings.
			</p>
		</div>
	);
}

/** The first chat's starters: complete requests a tap sends as written. */
export function Starters({
	starters,
	onPick,
}: {
	starters: readonly string[];
	/** Send it as written. */
	onPick?: ((starter: string) => void) | undefined;
}) {
	return (
		<div className="flex flex-col items-start gap-2">
			{starters.map((starter) => (
				<button
					key={starter}
					type="button"
					onClick={() => onPick?.(starter)}
					className="rounded-bubble border border-line px-3.5 py-2 text-left text-ui text-ink hover:bg-paper-3"
				>
					{starter}
				</button>
			))}
		</div>
	);
}
