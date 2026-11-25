/** A refused act says the daemon's own words whenever it named its refusal, whatever the status. */
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: () => {} } }));
vi.mock("./transport.ts", () => ({ pickTransport: () => ({ identified: false }) }));
vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });
vi.stubGlobal("history", { replaceState: () => {} });
vi.stubGlobal("addEventListener", () => {});

const { Refused, Unauthorized } = await import("./api.ts");
const { failureWords } = await import("./attempt.ts");

describe("failureWords", () => {
	it("shows a 503 carrying its fixed word in the daemon's words, capitalised", () => {
		expect(failureWords(new Refused("the keychain is locked: unlock it and try again", 503, "locked"))).toBe(
			"The keychain is locked: unlock it and try again",
		);
		expect(
			failureWords(new Refused("put back the auth/device-id this home had, then start banda again", 503, "identity")),
		).toBe("Put back the auth/device-id this home had, then start banda again");
	});

	it("keeps the generic words for a 5xx nobody named, and the daemon's words for a 4xx", () => {
		expect(failureWords(new Refused("TypeError: x is undefined", 500))).toBe(
			"banda on this computer hit a problem. Try again in a moment.",
		);
		expect(failureWords(new Refused("that name is taken", 409))).toBe("That name is taken");
		expect(failureWords(new Unauthorized())).toMatch(/lost its sign-in/);
	});
});
