/**
 * Settings' servers of the owner's, live: read from the daemon while the Model tab shows and after each change, to use,
 * check, edit or remove. On a phone too: a server takes no sign-in, and its address is said as the computer banda runs
 * on sees it. Adding one is Add a provider's (`./SettingsProviders.tsx`).
 */
import { listServerModels, useCustomProviders } from "../areas/custom-providers.ts";
import { CustomProviders } from "../chat/CustomProviders.tsx";
import { runsOnDevice } from "../lib/api.ts";

export function SettingsCustomProviders({ current }: { current: string }) {
	const { view, checking, error, edit, remove, use, check } = useCustomProviders(current);
	if (view === undefined || (view.providers.length === 0 && view.error === undefined)) return null;
	return (
		<CustomProviders
			view={view}
			current={current}
			here={!runsOnDevice}
			checking={checking}
			error={error}
			list={listServerModels}
			onEdit={edit}
			onRemove={remove}
			onUse={(id) => void use(id)}
			onCheck={(id) => void check(id)}
		/>
	);
}
