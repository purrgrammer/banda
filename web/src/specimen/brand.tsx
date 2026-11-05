import type { ComponentProps } from "react";
import { Band as ChatBand } from "../chat/Band.tsx";
import { FirstRun as ChatFirstRun } from "../chat/FirstRun.tsx";

/** The specimen uses the app's navigation without an added wordmark or icon. */
export function Band(props: ComponentProps<typeof ChatBand>) {
	return <ChatBand {...props} />;
}

export function FirstRun(props: ComponentProps<typeof ChatFirstRun>) {
	return <ChatFirstRun {...props} />;
}
