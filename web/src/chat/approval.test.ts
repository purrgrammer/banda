/**
 * A held request's approval card: it leads with what it is and the fields it sends, and keeps the request whole
 * (headers, raw body) behind "Details", shut until the owner opens it.
 */
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Ask } from "../lib/api.ts";
import { argList, draftParts } from "../lib/chat.ts";
import { ApprovalCard, Details, Facts } from "./Approval.tsx";

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
