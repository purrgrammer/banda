/**
 * banda.rocks lists the agents of the ACP registry (agentclientprotocol.com, Apache-2.0), any of which banda can hand
 * work to as a harness. The site ships a copy: its build reads no network, and opening it tells the registry nothing.
 * `npm run site:acp` takes a fresh copy into site/acp/: registry.json (each agent's id, name and link) and its icons.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";

const REGISTRY = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const out = new URL("../site/acp/", import.meta.url);

type Agent = { id: string; name: string; website?: string; repository?: string; icon?: string };

const fetched = (await (await fetch(REGISTRY)).json()) as { agents: Agent[] };
const agents = fetched.agents
	.filter((agent) => /^[a-z0-9-]+$/.test(agent.id))
	.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
await mkdir(out, { recursive: true });
for (const name of await readdir(out)) if (name.endsWith(".svg")) await rm(new URL(name, out));
const listed = [];
for (const agent of agents) {
	let icon = false;
	if (agent.icon?.startsWith("https://cdn.agentclientprotocol.com/")) {
		const response = await fetch(agent.icon);
		const svg = await response.text();
		// an icon is drawn as a mask on the page, never run: anything but a plain drawing stays out
		if (response.ok && svg.trimStart().startsWith("<svg") && !/<script|\son\w+=|href="(?!#)/i.test(svg)) {
			await writeFile(new URL(`${agent.id}.svg`, out), svg);
			icon = true;
		}
	}
	listed.push({ id: agent.id, name: agent.name, link: agent.website ?? agent.repository, icon });
}
await writeFile(new URL("registry.json", out), `${JSON.stringify({ from: REGISTRY, agents: listed }, null, "\t")}\n`);
console.log(`${listed.length} agents, ${listed.filter((agent) => agent.icon).length} with icons`);
