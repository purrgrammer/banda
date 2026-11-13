import type { Page } from "./chrome.ts";

export async function chooseMessageAction(
	page: Pick<Page, "run" | "until">,
	trigger: string,
	action: "Copy" | "Activity & transcript",
) {
	await page.until(trigger);
	await page.run(`(() => {
		const button = ${trigger};
		button.focus();
		button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	})()`);
	const item = `[...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === ${JSON.stringify(action)})`;
	await page.until(item);
	await page.run(`${item}.click()`);
}
