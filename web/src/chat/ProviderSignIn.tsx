/**
 * A provider's sign-in under way, in a tab of its own: the code or the address the provider's page ends on, pasted here
 * when that page never comes back; the provider's other ways to sign in; and Cancel. At first run and in Settings alike.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

export type SignInWay = { readonly id: string; readonly label: string };

export function ProviderSignIn({
	provider,
	asks,
	ways,
	way,
	className,
	onAnswer,
	onWay,
	onCancel,
}: {
	provider: { readonly id: string; readonly name: string };
	/** The sign-in takes a pasted code or address now. */
	asks?: boolean | undefined;
	/** The provider's ways to sign in, and the one under way. */
	ways?: readonly SignInWay[] | undefined;
	way?: string | undefined;
	className?: string | undefined;
	onAnswer?: ((id: string, value: string) => void) | undefined;
	/** Start again another way; the attempt under way ends. */
	onWay?: ((id: string, way: string) => void) | undefined;
	onCancel?: ((id: string) => void) | undefined;
}) {
	const others = (ways ?? []).filter((each) => each.id !== way);
	return (
		<div className={cn("flex flex-col gap-2", className)}>
			{asks === true ? (
				<form
					className="flex flex-col gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						const value = new FormData(event.currentTarget).get("code");
						if (typeof value === "string" && value.trim() !== "") onAnswer?.(provider.id, value.trim());
					}}
				>
					<span className="text-meta text-ink-2">
						Page didn't come back here? Paste the code {provider.name} shows, or the page's address.
					</span>
					<span className="flex gap-2">
						<Input
							name="code"
							autoComplete="off"
							aria-label={`${provider.name} sign-in code`}
							placeholder="Paste the code or address"
							className="flex-1 bg-paper"
						/>
						<Button type="submit">Finish</Button>
					</span>
				</form>
			) : null}
			<span className="flex flex-wrap items-center gap-1.5">
				{others.map((each) => (
					<Button key={each.id} variant="outline" size="xs" onClick={() => onWay?.(provider.id, each.id)}>
						{each.label}
					</Button>
				))}
				<Button
					variant="ghost"
					size="xs"
					aria-label={`Cancel signing in to ${provider.name}`}
					onClick={() => onCancel?.(provider.id)}
				>
					Cancel
				</Button>
			</span>
		</div>
	);
}
