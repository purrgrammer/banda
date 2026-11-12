import { CheckIcon, ChevronsUpDownIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import type { ModelView } from "../../../src/server/api/tiers.ts";
import { ProviderMark } from "./ProviderMark.tsx";

export function ModelPicker({
	tier,
	provider,
	current,
	catalog,
	onChange,
}: {
	tier: string;
	provider: string;
	current: ModelView & { readonly own?: true };
	catalog: readonly ModelView[];
	onChange: (model: string | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const choose = (model: string | null) => {
		setOpen(false);
		if (model !== current.id) onChange(model);
	};
	return (
		<ModelSelector open={open} onOpenChange={setOpen}>
			<ModelSelectorTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					aria-label={`Change ${tier} model: ${current.name}`}
					className="max-w-[min(11rem,42vw)] min-w-0 justify-between px-2 sm:max-w-56"
				>
					<ProviderMark provider={provider} />
					<span className="min-w-0 flex-1 truncate">{current.name}</span>
					<ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-2" />
				</Button>
			</ModelSelectorTrigger>
			<ModelSelectorContent title={`Choose the ${tier} model`} showCloseButton={false}>
				<ModelSelectorInput aria-label="Search models" placeholder="Search models…" />
				<ModelSelectorList>
					<ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
					<ModelSelectorGroup heading={`${tier} model`}>
						{current.own === true ? (
							<ModelSelectorItem value="Restore default model" onSelect={() => choose(null)}>
								<RotateCcwIcon aria-hidden="true" /> Restore default
							</ModelSelectorItem>
						) : null}
						{catalog.map(({ id, name }) => (
							<ModelSelectorItem key={id} value={id} keywords={[name]} onSelect={() => choose(id)}>
								<ProviderMark provider={provider} />
								<span className="min-w-0 flex-1 truncate">{name}</span>
								{id === current.id ? (
									<>
										<CheckIcon aria-hidden="true" className="size-4" />
										<span className="sr-only">Current model</span>
									</>
								) : null}
							</ModelSelectorItem>
						))}
					</ModelSelectorGroup>
				</ModelSelectorList>
			</ModelSelectorContent>
		</ModelSelector>
	);
}
