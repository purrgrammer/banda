/** What a connection's tools may do, on the daemon's data: Settings' list and the review after sign-in, sent as set. */
import { useState } from "react";
import { toast } from "sonner";
import type { ConnectionView } from "../../../src/server/api.ts";
import { ToolReview, ToolSettings } from "../chat/ToolKinds.tsx";
import { reviewTools, setGroupSetting, setToolSettings } from "../lib/api.ts";
import { showCapabilities } from "../lib/shell.ts";

/** A connection's tools in Settings: each change sent at once, for every agent. */
export function ConnectionToolSettings({ view, service }: { view: ConnectionView; service: string }) {
	const [busy, setBusy] = useState(false);
	const act = async (work: () => ReturnType<typeof setToolSettings>) => {
		setBusy(true);
		try {
			showCapabilities(await work());
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Couldn't change it. Try again.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<ToolSettings
			view={view}
			service={service}
			busy={busy}
			onTools={(settings) => void act(() => setToolSettings(view.name, settings))}
			onGroup={(group, setting) => void act(() => setGroupSetting(view.name, group, setting))}
		/>
	);
}

/** The review after sign-in, accepted with the file it showed. */
export function ConnectionToolReview(props: {
	view: ConnectionView;
	service: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<ToolReview
			{...props}
			onAccept={async (settings) =>
				showCapabilities(await reviewTools(props.view.name, props.view.accepted?.sha ?? "", settings))
			}
		/>
	);
}
