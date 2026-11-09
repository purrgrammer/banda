/**
 * Web Push sending (core/push.ts): RFC 8291 Appendix A both ways, a VAPID JWT that verifies, a fixed-size padded
 * payload, a local fake push service that receives what a subscription decrypts, and what each answer means.
 */
import { createECDH, randomBytes, verify } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	b64url,
	classifyPushResponse,
	decrypt,
	encrypt,
	fromB64url,
	generateVapidKeys,
	needsYouMessage,
	needsYouPayload,
	PADDED_PLAINTEXT_LENGTH,
	PUSH_BODY_LENGTH,
	parseRetryAfter,
	pushRequest,
	sendPush,
	vapidJwt,
	vapidPublicKeyObject,
} from "../src/core/push.js";

/** RFC 8291 Appendix A. */
const VECTOR = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A browser's side of a subscription: its key pair and auth secret. */
function userAgent(endpoint: string) {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = b64url(randomBytes(16));
	return {
		subscription: { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth } },
		secret: { privateKey: b64url(ecdh.getPrivateKey()), auth },
	};
}

function verifyJwt(jwt: string, publicKey: string) {
	const [header, claims, signature] = jwt.split(".");
	const ok = verify(
		"sha256",
		Buffer.from(`${header}.${claims}`),
		{ key: vapidPublicKeyObject(publicKey), dsaEncoding: "ieee-p1363" },
		fromB64url(signature),
	);
	return { ok, header: JSON.parse(fromB64url(header).toString()), claims: JSON.parse(fromB64url(claims).toString()) };
}

describe("RFC 8291 Appendix A", () => {
	it("encrypts the plaintext to the published body, byte for byte", () => {
		const body = encrypt(
			Buffer.from(VECTOR.plaintext),
			{ p256dh: VECTOR.uaPublic, auth: VECTOR.auth },
			{ salt: fromB64url(VECTOR.salt), serverPrivateKey: fromB64url(VECTOR.asPrivate) },
		);
		expect(b64url(body)).toBe(VECTOR.body);
	});

	it("decrypts the published body to the plaintext", () => {
		const plaintext = decrypt(fromB64url(VECTOR.body), { privateKey: VECTOR.uaPrivate, auth: VECTOR.auth });
		expect(plaintext.toString()).toBe(VECTOR.plaintext);
	});

	it("refuses a body under the wrong auth secret", () => {
		expect(() =>
			decrypt(fromB64url(VECTOR.body), { privateKey: VECTOR.uaPrivate, auth: b64url(Buffer.alloc(16)) }),
		).toThrow();
	});
});

describe("VAPID (RFC 8292)", () => {
	it("signs an ES256 JWT that verifies with the public key, for the endpoint's origin", () => {
		const keys = generateVapidKeys();
		expect(fromB64url(keys.publicKey)).toHaveLength(65);
		const now = Date.parse("2026-11-01T12:00:00Z");
		const jwt = vapidJwt({
			endpoint: "https://web.push.apple.com/QGuQ/abc?x=1",
			subject: "mailto:owner@example.com",
			keys,
			now,
		});
		const { ok, header, claims } = verifyJwt(jwt, keys.publicKey);
		expect(ok).toBe(true);
		expect(header).toEqual({ typ: "JWT", alg: "ES256" });
		expect(claims).toEqual({
			aud: "https://web.push.apple.com",
			exp: now / 1000 + 12 * 3600,
			sub: "mailto:owner@example.com",
		});
		expect(verifyJwt(jwt, generateVapidKeys().publicKey).ok).toBe(false);
	});

	it("refuses a subject that is not mailto: or https:", () => {
		expect(() =>
			vapidJwt({ endpoint: "https://x.test/1", subject: "http://localhost", keys: generateVapidKeys() }),
		).toThrow();
	});
});

describe("the payload", () => {
	it("is the fixed Declarative Web Push shape, and every body has the same size", () => {
		expect(JSON.parse(needsYouMessage("Sancho", 3))).toEqual({
			web_push: 8030,
			notification: { title: "Sancho needs you", navigate: "/#/", tag: "needs", app_badge: 3 },
		});
		const ua = userAgent("https://push.test/1");
		for (const name of ["S", "Sancho", "Dulcinea del Toboso 🌻", "x".repeat(5000)]) {
			const { plaintext, padding } = needsYouPayload(name, 12);
			expect(plaintext.length + 1 + padding).toBe(PADDED_PLAINTEXT_LENGTH);
			const body = encrypt(plaintext, ua.subscription.keys, { padding });
			expect(body).toHaveLength(PUSH_BODY_LENGTH);
			const message = JSON.parse(decrypt(body, ua.secret).toString());
			expect(message.notification.title.endsWith(" needs you")).toBe(true);
		}
	});
});

describe("a fake push service", () => {
	let close: (() => void) | undefined;
	afterEach(() => close?.());

	it("receives a request the subscription decrypts to the exact padded payload", async () => {
		const received: { headers: IncomingHttpHeaders; body: Buffer; url?: string }[] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				received.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url });
				res.writeHead(201).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		close = () => server.close();
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const ua = userAgent(`${origin}/push/abc`);
		const keys = generateVapidKeys();

		const outcome = await sendPush(
			ua.subscription,
			{ name: "Sancho", badge: 2 },
			{
				keys,
				subject: "https://banda.invalid",
				ttl: 86_400,
				urgency: "high",
				topic: "needs",
				allowHttp: true,
			},
		);
		expect(outcome).toEqual({ kind: "ok" });
		expect(received).toHaveLength(1);
		const [request] = received;
		expect(request.url).toBe("/push/abc");
		expect(request.headers["content-encoding"]).toBe("aes128gcm");
		expect(request.headers.ttl).toBe("86400");
		expect(request.headers.urgency).toBe("high");
		expect(request.headers.topic).toBe("needs");
		const auth = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.authorization ?? "");
		expect(auth?.[2]).toBe(keys.publicKey);
		const jwt = verifyJwt(auth?.[1] ?? "", auth?.[2] ?? "");
		expect(jwt.ok).toBe(true);
		expect(jwt.claims.aud).toBe(origin);
		expect(request.body).toHaveLength(PUSH_BODY_LENGTH);

		const { plaintext } = needsYouPayload("Sancho", 2);
		expect(decrypt(request.body, ua.secret).equals(plaintext)).toBe(true);
		expect(plaintext.toString()).toBe(needsYouMessage("Sancho", 2));
	});

	it("classifies the service's answers end to end, and a refused connection is a retry", async () => {
		const statuses = [410, 429, 503];
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				const status = statuses.shift() ?? 201;
				res.writeHead(status, status === 429 ? { "Retry-After": "7" } : {}).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		close = () => server.close();
		const ua = userAgent(`http://127.0.0.1:${(server.address() as AddressInfo).port}/p`);
		const options = { keys: generateVapidKeys(), subject: "mailto:o@example.com", ttl: 60, allowHttp: true };
		const send = () => sendPush(ua.subscription, { name: "S" }, options);
		expect(await send()).toEqual({ kind: "gone", status: 410 });
		expect(await send()).toEqual({ kind: "retry", status: 429, afterMs: 7000 });
		expect(await send()).toEqual({ kind: "retry", status: 503 });
		expect(await send()).toEqual({ kind: "ok" });
		server.close();
		await new Promise((resolve) => server.on("close", resolve));
		expect(await send()).toEqual({ kind: "retry" });
	});

	it("refuses an http endpoint unless told it is a test, and a topic that is not base64url", () => {
		const ua = userAgent("http://push.test/1");
		const options = { keys: generateVapidKeys(), subject: "mailto:o@example.com", ttl: 60 };
		expect(() => pushRequest(ua.subscription, Buffer.alloc(0), options)).toThrow(/https/);
		const secure = userAgent("https://push.test/1");
		expect(() => pushRequest(secure.subscription, Buffer.alloc(0), { ...options, topic: "needs you" })).toThrow(
			/topic/,
		);
	});
});

describe("classifyPushResponse", () => {
	const now = Date.parse("2026-11-01T12:00:00Z");
	it.each([
		[201, undefined, { kind: "ok" }],
		[404, undefined, { kind: "gone", status: 404 }],
		[410, undefined, { kind: "gone", status: 410 }],
		[429, "120", { kind: "retry", status: 429, afterMs: 120_000 }],
		[429, undefined, { kind: "retry", status: 429 }],
		[500, "Sun, 01 Nov 2026 12:00:30 GMT", { kind: "retry", status: 500, afterMs: 30_000 }],
		[502, "nonsense", { kind: "retry", status: 502 }],
		[400, undefined, { kind: "rejected", status: 400 }],
		[403, undefined, { kind: "rejected", status: 403 }],
		[413, undefined, { kind: "rejected", status: 413 }],
	])("%i (Retry-After %s)", (status, retryAfter, outcome) => {
		expect(classifyPushResponse(status, retryAfter, now)).toEqual(outcome);
	});

	it("reads a past HTTP-date as now", () => {
		expect(parseRetryAfter("Sun, 01 Nov 2026 11:00:00 GMT", now)).toBe(0);
	});
});
