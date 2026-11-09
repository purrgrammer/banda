/** A provider's key, pasted in: for one without a sign-in, at first run and in Settings alike. */
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

export function ProviderKeyForm({
	provider,
	action = "Start",
	busy,
	className,
	onKey,
}: {
	provider: { readonly id: string; readonly name: string; readonly keyUrl?: string | undefined };
	/** The submit button's word. */
	action?: string;
	busy?: boolean | undefined;
	className?: string | undefined;
	onKey?: ((id: string, key: string) => void) | undefined;
}) {
	return (
		<form
			className={cn("flex flex-col gap-2", className)}
			onSubmit={(event) => {
				event.preventDefault();
				const key = new FormData(event.currentTarget).get("key");
				if (typeof key === "string" && key.trim() !== "") onKey?.(provider.id, key.trim());
			}}
		>
			<span className="flex gap-2">
				<Input
					name="key"
					type="password"
					autoComplete="off"
					aria-label={`${provider.name} key`}
					placeholder="Paste your key"
					className="flex-1 bg-paper"
				/>
				<Button type="submit" disabled={busy}>
					{action}
				</Button>
			</span>
			{provider.keyUrl === undefined ? null : (
				<a
					href={provider.keyUrl}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 self-start text-meta text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
				>
					Get a key from {provider.name}
					<ExternalLinkIcon className="size-3" />
				</a>
			)}
		</form>
	);
}
