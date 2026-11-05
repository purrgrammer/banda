import { fileURLToPath } from "node:url";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentText } from "../src/core/agents.ts";
import { defaultAvatarFace } from "../src/core/avatar-face.ts";
import { PROPOSAL_ENTRY } from "../src/core/proposals.ts";
import { itemOf } from "../src/server/transcript.ts";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const fixture = fileURLToPath(new URL("./fixtures/meta-tools-browser.tsx", import.meta.url));
const agent = { id: "reader", name: "Reader", face: defaultAvatarFace() };
const proposal = {
	id: "proposal-1",
	chat: 1,
	from: "mara",
	kind: "agent",
	agentId: "writer",
	name: "Writer",
	face: defaultAvatarFace(),
	description: "Writes drafts",
	instructions: "Write carefully.",
	at: 1,
	state: "pending",
};
const before = {
	...agent,
	description: "Reads carefully",
	instructions: "Read carefully.",
	tools: [],
	state: "active" as const,
};
const after = {
	...before,
	name: "Researcher",
	description: "Checks sources",
	face: { ...before.face, color: "#4488aa" },
	instructions: "Check the sources.",
};
const change = itemOf({
	id: 2,
	kind: PROPOSAL_ENTRY,
	data: {
		id: "change",
		chat: 1,
		from: "reader",
		kind: "agentChange",
		agent: "reader",
		displayName: "Reader",
		base: "base",
		before: agentText(before),
		result: agentText(after),
		at: 1,
		state: "pending",
	},
} as unknown as EntryRecord);
if (change?.role !== "proposal") throw new Error("change fixture did not produce a review");
let server: ViteDevServer;
let url: string;

beforeAll(async () => {
	if (!hasChrome()) return;
	server = await createServer({
		configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
		server: { port: 0, host: "127.0.0.1", open: false },
		plugins: [
			{
				name: "meta-tools-fixture",
				resolveId: (id) => (id === "/meta-tools-fixture.tsx" ? fixture : undefined),
				load(id) {
					if (id !== fixture) return;
					return `import React from 'react'; import {createRoot} from 'react-dom/client';
					import {AgentMessage} from '/src/chat/AgentMessage.tsx'; import {Composer} from '/src/chat/Composer.tsx'; import {ProposalCard} from '/src/chat/Proposal.tsx';
					import '/src/styles/globals.css';
					const agent=${JSON.stringify(agent)}; const proposal=new URLSearchParams(location.search).has('change') ? ${JSON.stringify(change.proposal)} : ${JSON.stringify(proposal)};
					function App(){const [state,setState]=React.useState('pending'); const [sent,setSent]=React.useState(''); const [groupSent,setGroupSent]=React.useState('');
					return <main style={{padding:16,maxWidth:700,margin:'auto'}}><ProposalCard proposal={proposal} state={state}
					 onAct={async action=>{const next=action==='accept'?'accepted':'declined';setState(next);return next;}} />
					 <section id="agent-message"><AgentMessage author={{...agent,id:'reader'}} text="The details of the message are here." time="10:24" /></section>
					 <section id="direct"><h2>Direct chat</h2><Composer to="Mara" mentionables={[agent]} onSend={async text=>setSent(text)} /></section>
					 <p id="sent">{sent}</p><section id="group"><h2>Group chat</h2><Composer to="Research" group mentionables={[agent]} onSend={async text=>setGroupSent(text)} /></section>
					 <p id="group-sent">{groupSent}</p></main>}; createRoot(document.getElementById('root')).render(<App/>);`;
				},
				configureServer(vite) {
					vite.middlewares.use((req, res, next) => {
						if ((req.url ?? "").split("?")[0] === "/meta-tools") {
							void vite
								.transformIndexHtml(
									req.url ?? "",
									'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/meta-tools-fixture.tsx"></script>',
								)
								.then((html) => {
									res.setHeader("content-type", "text/html");
									res.end(html);
								});
							return;
						}
						next();
					});
				},
			},
		],
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("meta-tools fixture did not listen");
	url = `http://127.0.0.1:${address.port}/meta-tools`;
});
afterAll(async () => {
	await server?.close();
});

for (const width of [320, 390, 1440]) {
	it.skipIf(!hasChrome())(`renders an agent change from its recorded files at ${width}px`, async () => {
		await withPage(`${url}?change=1`, { width, height: 900 }, async (page) => {
			await page.until(`document.querySelector('[aria-label="Agent proposal"]')`);
			const card = `[aria-label="Agent proposal"]`;
			expect(await page.run(`document.querySelector('${card}').textContent`)).toContain("Update Reader");
			expect(await page.run(`document.querySelector('${card}').textContent`)).toContain("Researcher");
			expect(await page.run(`document.querySelectorAll('${card} img').length`)).toBe(2);
			expect(await page.run(`document.querySelector('${card} details').open`)).toBe(false);
			await page.run(`document.querySelector('${card} details > summary').click()`);
			await page.run(`document.querySelector('${card} details details > summary').click()`);
			expect(await page.run(`document.querySelector('${card}').innerText`)).toContain("Check the sources.");
			expect(await page.run(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
			expect(page.errors()).toEqual([]);
		});
	});
	it.skipIf(!hasChrome())(`proposal review and direct-chat @ reference fit at ${width}px`, async () => {
		await withPage(url, { width, height: 900 }, async (page) => {
			await page.until(`document.querySelector('[aria-label="Agent proposal"]')`);
			const proposalActions = await page.run(
				`Array.from(document.querySelectorAll('[aria-label="Agent proposal"] button'), b => b.textContent.trim())`,
			);
			expect(proposalActions).toContain("Cancel");
			expect(proposalActions).toContain("Create agent");
			expect(proposalActions).not.toContain("Keep as is");
			const collapsed = await page.run(`(() => { const row=document.querySelector('#agent-message');
				return row.querySelector('button[aria-expanded="false"]') !== null && !row.innerText.includes('details of the message'); })()`);
			expect(collapsed).toBe(true);
			expect(await page.run(`document.querySelector('#agent-message a').getAttribute('href')`)).toBe("#/a/reader");
			await page.run(`document.querySelector('#agent-message button[aria-expanded]').click()`);
			await page.until(`document.querySelector('#agent-message button[aria-expanded="true"]')`);
			expect(await page.run(`document.querySelector('#agent-message').innerText`)).toContain("details of the message");
			expect(
				await page.run(
					`getComputedStyle(document.querySelector('#agent-message [aria-label^="Hide message"]')).textAlign`,
				),
			).toBe("center");
			const centeredOpen =
				await page.run(`(() => { const root=document.querySelector('#agent-message').firstElementChild;
				const item=root.firstElementChild.getBoundingClientRect(); const line=root.getBoundingClientRect();
				return Math.abs((item.left+item.right-line.left-line.right)/2) < 2; })()`);
			expect(centeredOpen).toBe(true);
			await page.run(`document.querySelector('#agent-message button[aria-label="Hide message from Reader"]').click()`);
			await page.until(`document.querySelector('#agent-message button[aria-expanded="false"]')`);
			expect(await page.run(`document.querySelector('#agent-message').innerText`)).not.toContain(
				"details of the message",
			);
			const overflow = await page.run(`document.documentElement.scrollWidth > innerWidth`);
			expect(overflow).toBe(false);
			await page.run(`(() => { const field=document.querySelector('#direct textarea[name="message"]');
				const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
				setter.call(field,'@rea'); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
			await page.until(`document.querySelector('[role="listbox"]')`);
			await page.run(
				`document.querySelector('[role="option"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`,
			);
			await page.until(`document.querySelector('#direct textarea[name="message"]').value === '@Reader '`);
			await page.run(`document.querySelector('#direct button[aria-label="Send"]').click()`);
			await page.until(`document.querySelector('#sent').textContent === '@Reader '`);
			expect(await page.run(`document.querySelector('#sent').textContent`)).toBe("@Reader ");
			await page.run(`(() => { const field=document.querySelector('#group textarea[name="message"]');
				const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
				setter.call(field,'@rea'); field.dispatchEvent(new Event('input',{bubbles:true})); })()`);
			await page.until(`document.querySelector('#group [role="listbox"]')`);
			await page.run(
				`document.querySelector('#group [role="option"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`,
			);
			await page.until(`document.querySelector('#group').textContent.includes('To Reader')`);
			await page.run(`document.querySelector('#group button[aria-label="Send"]').click()`);
			await page.until(`document.querySelector('#group-sent').textContent === '@Reader '`);
			expect(await page.run(`document.querySelector('#group-sent').textContent`)).toBe("@Reader ");
			await page.run(
				`([...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Create agent')).click()`,
			);
			await page.until(`document.body.textContent.includes('Accepted')`);
			expect(
				await page.run(`document.querySelector('[aria-label="Agent proposal"]').textContent.includes('Accepted')`),
			).toBe(true);
			expect(page.errors()).toEqual([]);
		});
	});
}
