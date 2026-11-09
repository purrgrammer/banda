import { PlusIcon } from "lucide-react";
import { useEffect, useRef } from "react";

/** The native change event fires when a colour is committed, rather than on every drag. */
export function CustomColour({
	value,
	onChange,
	onCommit,
}: {
	value: string;
	onChange: (value: string) => void;
	onCommit: (value: string) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const commit = useRef(onCommit);
	commit.current = onCommit;
	useEffect(() => {
		const element = input.current;
		if (!element) return;
		const changed = () => commit.current(element.value);
		element.addEventListener("change", changed);
		return () => element.removeEventListener("change", changed);
	}, []);
	return (
		<label
			className="relative flex size-10 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-line bg-paper-2 text-ink hover:bg-paper-3 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus"
			title="Add a colour"
		>
			<PlusIcon aria-hidden="true" className="size-4" />
			<input
				ref={input}
				type="color"
				aria-label="Add a colour"
				value={value}
				onInput={(event) => onChange(event.currentTarget.value)}
				onChange={() => {}}
				className="absolute inset-0 size-full cursor-pointer opacity-0"
			/>
		</label>
	);
}
