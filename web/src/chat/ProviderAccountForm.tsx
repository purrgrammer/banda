/**
 * Another account of a provider the band already thinks with, in Settings: its name in the owner's words ("Work"),
 * then its key, or a sign-in in a tab of its own.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

export function ProviderAccountForm({
	provider,
	by,
	busy,
	className,
	onAdd,
	onClose,
}: {
	provider: { readonly id: string; readonly name: string };
	/** Signs in, or takes a key. */
	by: "sign-in" | "key";
	busy?: boolean | undefined;
	className?: string | undefined;
	/** The account's name, and its key for a provider that takes one. */
	onAdd?: ((provider: string, label: string, key?: string) => void) | undefined;
	onClose?: (() => void) | undefined;
}) {
	return (
		<form
			className={cn("flex flex-col gap-2", className)}
			onSubmit={(event) => {
				event.preventDefault();
				const form = new FormData(event.currentTarget);
				const label = form.get("label");
				const key = form.get("key");
				if (typeof label !== "string" || label.trim() === "") return;
				if (by === "sign-in") onAdd?.(provider.id, label.trim());
				else if (typeof key === "string" && key.trim() !== "") onAdd?.(provider.id, label.trim(), key.trim());
			}}
		>
			<Input
				name="label"
				autoComplete="off"
				maxLength={60}
				aria-label={`Name of the new ${provider.name} account`}
				placeholder="Its name, like Work or Personal"
				className="bg-paper"
			/>
			{by === "key" ? (
				<Input
					name="key"
					type="password"
					autoComplete="off"
					aria-label={`Key of the new ${provider.name} account`}
					placeholder="Paste its key"
					className="bg-paper"
				/>
			) : null}
			<span className="flex gap-1.5 self-end">
				<Button type="button" variant="ghost" size="xs" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" size="xs" disabled={busy}>
					{by === "sign-in" ? "Sign in" : "Add"}
				</Button>
			</span>
		</form>
	);
}
