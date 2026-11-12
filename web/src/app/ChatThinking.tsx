/** A chat's thinking selector, tied to the daemon: it reads and saves the tier itself, so a pick renders nothing else. */
import { setChatTier } from "../areas/tiers.ts";
import { ThinkingTiers } from "../chat/Settings.tsx";
import { sayFailed } from "../lib/attempt.ts";
import { useChatTier } from "../lib/shell.ts";

export function ChatThinking({ chat }: { chat: number | undefined }) {
	const { tier, custom } = useChatTier(chat);
	return (
		<ThinkingTiers
			key={chat}
			tier={tier}
			custom={custom}
			save={(picked) => (chat === undefined ? Promise.resolve() : setChatTier(chat, picked))}
			onFailed={(error, retry) => sayFailed("change how hard it thinks", error, retry)}
		/>
	);
}
