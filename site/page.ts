// The page below the hero: the ACP registry's agents from the copy in site/acp (`npm run site:acp`), and the showcase,
// fetched only as it nears the screen so the hero never waits on it.
import registry from "./acp/registry.json";

const icons = import.meta.glob<string>("./acp/*.svg", { eager: true, query: "?url", import: "default" });

const list = document.getElementById("acp-agents");
/** The registry's best-known agents; the rest are a link to it. */
const FEATURED = [
	"claude-acp",
	"codex-acp",
	"gemini",
	"github-copilot-cli",
	"cursor",
	"cline",
	"goose",
	"opencode",
	"amp-acp",
	"kiro",
	"qwen-code",
	"mistral-vibe",
];
/** The name people know an agent by, where the registry lists it under another. */
const KNOWN_AS: Record<string, string> = { "claude-acp": "Claude Code" };

if (list) {
	const featured = FEATURED.flatMap((id) => registry.agents.filter((agent) => agent.id === id));
	for (const agent of featured) {
		const item = document.createElement("span");
		const name = KNOWN_AS[agent.id] ?? agent.name;
		const url = agent.icon ? icons[`./acp/${agent.id}.svg`] : undefined;
		if (url) {
			const icon = document.createElement("i");
			icon.setAttribute("aria-hidden", "true");
			icon.style.maskImage = `url("${url}")`;
			item.append(icon);
		}
		if (agent.link) {
			const link = document.createElement("a");
			link.href = agent.link;
			link.textContent = name;
			item.append(link);
		} else item.append(name);
		list.append(item);
	}
	const more = document.createElement("span");
	const link = document.createElement("a");
	link.href = "https://github.com/agentclientprotocol/registry";
	link.textContent = `+${registry.agents.length - featured.length} more in the ACP registry`;
	more.append(link);
	list.append(more);
}
for (const count of document.querySelectorAll("[data-acp-count]"))
	count.textContent = `${registry.agents.length} agents`;

const showcases = [...document.querySelectorAll<HTMLElement>("[data-showcase]")];
if (showcases.length > 0) {
	const near = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			near.disconnect();
			void import("./showcase.tsx").then(({ mountShowcases }) => mountShowcases(showcases));
		},
		{ rootMargin: "800px 0px" },
	);
	for (const showcase of showcases) near.observe(showcase);
}
