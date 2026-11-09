/**
 * A held request's approval card: it leads with what it is and the fields it sends, and keeps the request whole
 * (headers, raw body) behind "Details", shut until the owner opens it.
 */
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Ask } from "../lib/api.ts";
import { argList, draftParts, wildcardWarning } from "../lib/chat.ts";
import { ApprovalCard, Details, Facts, HostsWarning } from "./Approval.tsx";

const ask: Extract<Ask, { type: "approval" }> = {
	type: "approval",
	tool: "browser_send",
	label: "send a request from www.cp.pt to api-gateway.cp.pt/cp/services/travel-api/journeys",
	details: ["page", "method", "address", "headers", "body"],
	floor: "credentials",
	args: {
		sends: { travelDate: "2026-12-12", filters: "(2 fields)" },
		page: "www.cp.pt",
		method: "POST",
		address: "https://api-gateway.cp.pt/cp/services/travel-api/journeys",
		headers: "Content-Type: application/json\nx-api-key: ca39… (32 characters)",
		body: '{"travelDate":"2026-12-12","filters":{"class":2,"adults":1}}',
		_write: "w1",
		_hash: "abc",
	},
};

const card = (rows: [string, string][], details: [string, string][]) =>
	renderToStaticMarkup(
		createElement(ApprovalCard, {
			agent: "Mara",
			what: ask.label ?? "",
			verb: "Send",
			object: createElement(Fragment, null, createElement(Facts, { rows }), createElement(Details, { rows: details })),
		}),
	);

describe("a held request's card", () => {
	it("lays the draft out as facts it leads with and details behind a disclosure", () => {
		const parts = draftParts(ask);
		expect(parts.fields).toEqual([]);
		expect(argList(parts.rest)).toEqual([
			["sends › travelDate", "2026-12-12"],
			["sends › filters", "(2 fields)"],
		]);
		expect(parts.details.map(([term]) => term)).toEqual(["page", "method", "address", "headers", "body"]);
	});

	it("shows what it is and what it sends; the headers wait, shut, behind Details", () => {
		const parts = draftParts(ask);
		const html = card(argList(parts.rest), parts.details);
		expect(html).toContain("Mara asks to");
		expect(html).toContain("send a request from www.cp.pt to api-gateway.cp.pt/cp/services/travel-api/journeys");
		expect(html).toContain("sends › travelDate");
		expect(html).toContain("Details");
		expect(html).not.toContain("x-api-key");
		expect(html).toContain("Don&#x27;t send");
	});

	it("an approval with no details draws no disclosure, and keeps every argument as a fact", () => {
		const { details: _details, ...rest } = ask;
		const plain: typeof ask = { ...rest, args: { to: "ines@example.com" } };
		const parts = draftParts(plain);
		expect(parts.details).toEqual([]);
		expect(argList(parts.rest)).toEqual([["to", "ines@example.com"]]);
	});
});

describe("an ask_hosts draft naming *", () => {
	it("flags * for what it is: every host", () => {
		expect(wildcardWarning("ask_hosts", "relay.damus.io\nnos.lol\n*")).toContain("every host");
		expect(wildcardWarning("ask_hosts", " * ")).toContain("every host");
	});

	it("says nothing for plain hosts or patterns, and the owner's trim clears it", () => {
		expect(wildcardWarning("ask_hosts", "relay.damus.io\n*.example.com")).toBeUndefined();
		// the owner trimmed the * line out before approving
		expect(wildcardWarning("ask_hosts", "relay.damus.io\nnos.lol")).toBeUndefined();
		// another tool's argument happening to hold * is not an ask for every host
		expect(wildcardWarning("browser_send", "*")).toBeUndefined();
	});

	it("draws the mark in red, as an alert", () => {
		const warning = wildcardWarning("ask_hosts", "*");
		expect(warning).toBeDefined();
		const html = renderToStaticMarkup(createElement(HostsWarning, { warning: warning as string }));
		expect(html).toContain('role="alert"');
		expect(html).toContain("text-danger");
		expect(html).toContain("every host");
	});
});
