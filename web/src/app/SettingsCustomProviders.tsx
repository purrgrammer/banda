/**
 * Settings' custom providers, live: read from the daemon while the Model tab shows and after each change. On a phone
 * too: a custom provider takes no sign-in, and its address is said as the computer banda runs on sees it.
 */
import { useCustomProviders } from "../areas/custom-providers.ts";
import { CustomProviders } from "../chat/CustomProviders.tsx";
import { runsOnDevice } from "../lib/api.ts";

export function SettingsCustomProviders({ current }: { current: string }) {
	const { view, checking, error, add, edit, remove, use, check } = useCustomProviders(current);
	return (
		<CustomProviders
			view={view}
			current={current}
			here={!runsOnDevice}
			checking={checking}
			error={error}
			onAdd={add}
			onEdit={edit}
			onRemove={remove}
			onUse={(id) => void use(id)}
			onCheck={(id) => void check(id)}
		/>
	);
}
