import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hasChrome, withPage } from "./smoke/chrome.ts";

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>button {position:absolute;top:200px;width:110px;height:40px} #allow {left:20px} #decline {left:140px}</style>
</head><body><button id="allow">Allow</button><button id="decline">Don't allow</button><script>
window.answers = {deny: 0, allow: 0};
window.pointers = [];
for (const type of ['pointerdown', 'pointerup']) window.addEventListener(type, event => {
  pointers.push({type, trusted: event.isTrusted, target: event.target.id});
}, true);
document.addEventListener('click', event => {
  if (event.target.id === 'decline') { answers.deny++; window.answeredAt = window.frame; }
  if (event.target.id === 'allow') answers.allow++;
});
window.frame = 0;
window.move = () => {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;left:140px;width:110px;height:40px;z-index:2';
  document.body.append(overlay);
  const step = () => {
    window.frame++;
    let decline = document.querySelector('#decline');
    if (frame === 4) {
      const replacement = decline.cloneNode(true);
      decline.replaceWith(replacement);
      decline = replacement;
      window.replaced = true;
    }
    decline.disabled = frame < 6;
    decline.style.top = 200 + frame * 2 + 'px';
    overlay.style.top = decline.style.top;
    if (frame === 8) overlay.remove();
    if (frame < 20) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};
</script></body></html>`;
const url = `data:text/html,${encodeURIComponent(fixture)}`;
const target = "document.querySelector('#decline')";

for (const width of [1440, 390]) {
	it.skipIf(!hasChrome())(
		`native decline follows movement and a replacement after a screenshot at ${width}px`,
		async () => {
			const output = await mkdtemp(join(tmpdir(), "banda-click-"));
			try {
				await withPage(url, { width, height: 900 }, async (page) => {
					const before = await page.run<number>(`${target}.getBoundingClientRect().top`);
					await page.run("move()");
					await page.shoot(join(output, "moving.png"));
					await page.click(target);
					expect(await page.run("answers")).toEqual({ deny: 1, allow: 0 });
					expect(await page.run("answeredAt")).toBe(20);
					expect(await page.run("replaced")).toBe(true);
					expect(await page.run<number>(`${target}.getBoundingClientRect().top`)).toBe(before + 40);
					expect(await page.run("pointers")).toEqual([
						{ type: "pointerdown", trusted: true, target: "decline" },
						{ type: "pointerup", trusted: true, target: "decline" },
					]);
					expect(await page.run("Object.keys(window).filter(key => key.startsWith('banda-click-'))")).toEqual([]);
					expect(page.errors()).toEqual([]);
				});
			} finally {
				await rm(output, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!hasChrome())(
		`native decline refuses a late move onto Allow without another press at ${width}px`,
		async () => {
			await withPage(url, { width, height: 900 }, async (page) => {
				await page.run(`window.addEventListener('pointerdown', () => {
				document.querySelector('#decline').style.left = '270px';
				document.querySelector('#allow').style.left = '140px';
			}, {capture: true, once: true})`);
				await expect(page.click(target)).rejects.toThrow(/Native click refused.*hit BUTTON#allow Allow/);
				expect(await page.run("answers")).toEqual({ deny: 0, allow: 0 });
				expect(await page.run("pointers")).toEqual([
					{ type: "pointerdown", trusted: true, target: "decline" },
					{ type: "pointerup", trusted: true, target: "allow" },
				]);
				expect(await page.run("Object.keys(window).filter(key => key.startsWith('banda-click-'))")).toEqual([]);
				expect(page.errors()).toEqual([]);
			});
		},
	);

	for (const [name, change, refusal] of [
		["disabled", "document.querySelector('#decline').disabled = true", "disabled element"],
		["disconnected", "document.querySelector('#decline').remove()", "missing or disconnected element"],
		["outside the viewport", "document.querySelector('#decline').style.top = '-100px'", "element outside viewport"],
	])
		it.skipIf(!hasChrome())(
			`native decline refuses a target that becomes ${name} during input at ${width}px`,
			async () => {
				await withPage(url, { width, height: 900 }, async (page) => {
					await page.run(`window.addEventListener('pointerdown', () => { ${change} }, {capture: true, once: true})`);
					await expect(page.click(target)).rejects.toThrow(refusal);
					expect(await page.run("answers")).toEqual({ deny: 0, allow: 0 });
					expect(await page.run("pointers.map(event => event.type)")).toEqual(["pointerdown", "pointerup"]);
					expect(await page.run("Object.keys(window).filter(key => key.startsWith('banda-click-'))")).toEqual([]);
					expect(page.errors()).toEqual([]);
				});
			},
		);
}
