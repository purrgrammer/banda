/**
 * Settings' providers on a device: a sign-in comes back to the computer banda runs on, so a device shows the
 * connected providers alone, to use or sign out of, and never offers to connect one.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelProviders, type ProviderRow } from "./Settings.tsx";

const providers: readonly ProviderRow[] = [
	{ id: "anthropic", name: "Anthropic", by: "sign-in", connected: true },
	{ id: "openai", name: "OpenAI", by: "sign-in", connected: true },
	{ id: "xai", name: "xAI", by: "sign-in", connected: true, ambient: true, source: "XAI_API_KEY" },
	{ id: "github-copilot", name: "GitHub Copilot", by: "sign-in", connected: false, connecting: true, asks: true },
	{ id: "mistral", name: "Mistral", by: "key", connected: false },
];

const html = (here?: boolean) =>
	renderToStaticMarkup(
		createElement(ModelProviders, {
			current: "anthropic",
			providers,
			open: "mistral",
			...(here === undefined ? {} : { here }),
		}),
	);

describe("Settings' providers", () => {
	it("offers to connect every provider on the computer banda runs on", () => {
		const page = html();
		expect(page).toContain('aria-label="Connect Mistral"');
		expect(page).toContain('aria-label="Connect xAI"');
		expect(page).toContain("GitHub Copilot");
	});

	it("shows a device the connected providers alone, with nothing to connect", () => {
		const page = html(false);
		expect(page).not.toContain("Connect Mistral");
		expect(page).not.toContain("Mistral");
		expect(page).not.toContain("GitHub Copilot");
		expect(page).not.toContain('aria-label="Connect');
		expect(page).toContain('aria-label="Use OpenAI"');
		expect(page).toContain('aria-label="Use xAI"');
		expect(page).toContain('aria-label="Sign out of OpenAI"');
		expect(page).toContain("on the computer banda runs on");
	});
});
