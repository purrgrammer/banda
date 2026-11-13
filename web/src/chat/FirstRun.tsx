/**
 * First run: the first agent, and the model providers to pick from. The one picked signs the owner in, or takes a key
 * where it has no sign-in; one screen, no other step. Then the chat opens with the agent's first words.
 */
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/cn";
import { defaultAvatarFace } from "../../../src/core/avatar-face.ts";
import { Face } from "./Face.tsx";
import { ProviderKeyForm } from "./ProviderKeyForm.tsx";
import { ProviderMark } from "./ProviderMark.tsx";
import { ProviderSignIn, type SignInWay } from "./ProviderSignIn.tsx";

const FIRST_FACE = defaultAvatarFace();

export type ProviderChoice = {
	readonly id: string;
	readonly name: string;
	/** Signs in, or takes a key. */
	readonly by: "sign-in" | "key";
	readonly note?: string | undefined;
	/** Where a key is made, for a provider that takes one. */
	readonly keyUrl?: string | undefined;
	/** A sign-in under way: whether it takes a pasted code now, the provider's ways to sign in and the one it takes. */
	readonly connecting?: boolean | undefined;
	readonly asks?: boolean | undefined;
	readonly ways?: readonly SignInWay[] | undefined;
	readonly way?: string | undefined;
};

/** Every other way to think, found by search: a provider set up in Add a provider, or a server of the owner's. */
export type OtherChoice = {
	readonly id: string;
	readonly name: string;
	readonly note: string;
	/** Words a search finds it by besides its name (`local`, `self-hosted`). */
	readonly keywords?: readonly string[];
	readonly mark: ReactNode;
};

/** More than this many choices, and the list can be searched. */
const SEARCH_FROM = 6;

export function FirstRun({
	providers,
	open,
	waiting,
	error,
	onPick,
	onKey,
	onAnswer,
	onWay,
	onCancel,
	more,
	others = [],
	onOther,
}: {
	/** What a search finds past the providers listed: Add a provider opens on the one picked. */
	others?: readonly OtherChoice[];
	onOther?: (id: string) => void;
	/** Every other provider, and servers of the owner's: Add a provider. */
	more?: ReactNode;
	providers: readonly ProviderChoice[];
	/** The provider whose key form is open. */
	open?: string | undefined;
	/** A sign-in under way at this provider, in its own tab. */
	waiting?: string | undefined;
	/** What went wrong, who, what and the fix, in words. */
	error?: string | undefined;
	onPick?: (id: string) => void;
	onKey?: (id: string, key: string) => void;
	/** A sign-in's pasted code or address; another way to sign in; ending the sign-in under way. */
	onAnswer?: (id: string, value: string) => void;
	onWay?: (id: string, way: string) => void;
	onCancel?: (id: string) => void;
}) {
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();
	const finds = (...words: readonly string[]) => words.some((word) => word.toLowerCase().includes(needle));
	const shown = needle === "" ? providers : providers.filter((provider) => finds(provider.name, provider.id));
	const found = needle === "" ? [] : others.filter((other) => finds(other.name, other.id, ...(other.keywords ?? [])));
	const searchable = providers.length + others.length > SEARCH_FROM;
	return (
		<div className="flex h-full flex-col items-center overflow-y-auto bg-paper px-4 py-12">
			<div className="flex w-full max-w-sm shrink-0 flex-col items-center gap-3 text-center">
				<Face face={FIRST_FACE} name="Sancho" size="hero" />
				<h1 className="mt-2 text-display font-semibold text-ink">Sancho</h1>
				<p className="text-body text-ink-2">
					I'm the first of your band. Pick the model I think with, and we can start.
				</p>
			</div>
			{searchable ? (
				<label className="mt-8 flex h-10 w-full max-w-sm shrink-0 items-center gap-2 rounded-tile border border-line-soft px-3.5 focus-within:ring-2 focus-within:ring-ring">
					<SearchIcon aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
					<input
						type="search"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={`Search ${providers.length + others.length} providers and servers`}
						aria-label="Search providers and servers"
						autoComplete="off"
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-ink-3"
					/>
				</label>
			) : null}
			<ul
				className={cn(
					"flex w-full max-w-sm shrink-0 flex-col divide-y divide-line-soft overflow-y-auto overscroll-contain max-h-[min(24rem,50dvh)] rounded-tile border border-line-soft",
					searchable ? "mt-2" : "mt-8",
					shown.length + found.length === 0 && "hidden",
				)}
			>
				{shown.map((provider) => {
					const signing = provider.by === "sign-in" && (provider.id === waiting || provider.connecting === true);
					return (
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
								<ProviderMark provider={provider.id} className="size-6" />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="text-ui font-medium text-ink">{provider.name}</span>
									<span className="text-meta text-ink-2">
										{signing
											? "Finish signing in in the other tab…"
											: (provider.note ?? (provider.by === "sign-in" ? "Sign in with your account" : "Use a key"))}
									</span>
								</span>
								<ChevronRightIcon className={cn("size-4 text-ink-3", provider.id === open && "rotate-90")} />
							</button>
							{provider.id === open ? (
								<ProviderKeyForm provider={provider} className="bg-paper-2 px-3.5 pb-3.5" onKey={onKey} />
							) : null}
							{signing ? (
								<ProviderSignIn
									provider={provider}
									asks={provider.asks}
									ways={provider.ways}
									way={provider.way}
									className="bg-paper-2 px-3.5 pt-1 pb-3.5"
									onAnswer={onAnswer}
									onWay={onWay}
									onCancel={onCancel}
								/>
							) : null}
						</li>
					);
				})}
				{found.map((other) => (
					<li key={other.id}>
						<button
							type="button"
							onClick={() => onOther?.(other.id)}
							className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-paper-2"
						>
							<span className="flex size-6 shrink-0 items-center justify-center">{other.mark}</span>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="text-ui font-medium text-ink">{other.name}</span>
								<span className="text-meta text-ink-2">{other.note}</span>
							</span>
							<ChevronRightIcon className="size-4 text-ink-3" />
						</button>
					</li>
				))}
			</ul>
			{shown.length + found.length === 0 ? (
				<p role="status" className="mt-3 max-w-sm text-center text-ui text-ink-2">
					Nothing called “{search.trim()}”. A server of your own can be added by its address.
				</p>
			) : null}
			{more}
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
