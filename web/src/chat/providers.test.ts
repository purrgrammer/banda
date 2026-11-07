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

	it("names a provider's accounts by their labels once it has more than one, and offers another", () => {
		const accounts: readonly ProviderRow[] = [
			{ id: "anthropic", name: "Anthropic", provider: "anthropic", label: "Personal", by: "sign-in", connected: true },
			{ id: "anthropic@work", name: "Anthropic", provider: "anthropic", label: "Work", by: "sign-in", connected: true },
			{ id: "openai", name: "OpenAI", provider: "openai", label: "OpenAI", by: "sign-in", connected: true },
		];
		const page = renderToStaticMarkup(
			createElement(ModelProviders, { current: "anthropic@work", providers: accounts, onAdd: () => {} }),
		);
		expect(page).toContain('aria-label="Use Anthropic · Personal"');
		expect(page).toContain('aria-label="Sign out of Anthropic · Work"');
		// one account of a provider is named by the provider alone
		expect(page).toContain('aria-label="Use OpenAI"');
		expect(page).toContain('aria-label="Add another Anthropic account"');
		expect(page).toContain('aria-label="Add another OpenAI account"');
		expect(page).toContain('src="/providers/anthropic.svg"');
		expect(page).not.toContain("anthropic@work.svg");
		const adding = renderToStaticMarkup(
			createElement(ModelProviders, {
				current: "anthropic",
				providers: accounts,
				onAdd: () => {},
				adding: "anthropic",
			}),
		);
		expect(adding).toContain('aria-label="Name of the new Anthropic account"');
		// a device adds nothing: a sign-in comes back to the computer banda runs on
		const device = renderToStaticMarkup(
			createElement(ModelProviders, { current: "anthropic", providers: accounts, onAdd: () => {}, here: false }),
		);
		expect(device).not.toContain("Add another");
	});

	it("renames an account only where a provider has more than one, starting from its name", () => {
		const accounts: readonly ProviderRow[] = [
			{ id: "anthropic", name: "Anthropic", provider: "anthropic", label: "Anthropic", by: "sign-in", connected: true },
			{ id: "anthropic@work", name: "Anthropic", provider: "anthropic", label: "Work", by: "sign-in", connected: true },
			{ id: "openai", name: "OpenAI", provider: "openai", label: "OpenAI", by: "sign-in", connected: true },
		];
		const page = renderToStaticMarkup(
			createElement(ModelProviders, { current: "anthropic", providers: accounts, onRename: () => {} }),
		);
		expect(page).toContain('aria-label="Rename Anthropic"');
		expect(page).toContain('aria-label="Rename Anthropic · Work"');
		expect(page).not.toContain('aria-label="Rename OpenAI"');
		// a phone gathers Rename and Sign out under one menu, where a label makes the row long
		expect(page).toContain('aria-label="More for Anthropic · Work"');
		expect(page).not.toContain('aria-label="More for OpenAI"');
		const renaming = renderToStaticMarkup(
			createElement(ModelProviders, {
				current: "anthropic",
				providers: accounts,
				onRename: () => {},
				renaming: "anthropic@work",
			}),
		);
		expect(renaming).toContain('aria-label="New name for Anthropic · Work"');
		expect(renaming).toContain('value="Work"');
	});
});
