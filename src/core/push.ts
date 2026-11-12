/**
 * core/push.ts: the daemon as its own Web Push application server, on node:crypto alone. `vapidAuthorization` signs
 * an RFC 8292 VAPID JWT (ES256, P-256); `encrypt` / `decrypt` are RFC 8291 message encryption over RFC 8188
 * aes128gcm (ECDH + HKDF + AES-128-GCM, one record); `needsYouPayload` is the one plaintext banda ever pushes, padded
 * to a constant size so the push service learns nothing from its length; `pushRequest` / `sendPush` build and send it
 * with TTL, Urgency and Topic; `classifyPushResponse` says what the push service's answer means.
 */
import {
	createCipheriv,
	createDecipheriv,
	createECDH,
	createPrivateKey,
	createPublicKey,
	hkdfSync,
	randomBytes,
	sign,
} from "node:crypto";
import { parseRetryAfter } from "./retry-after.ts";

export { parseRetryAfter };

/** A VAPID key pair: `publicKey` is the uncompressed P-256 point (65 bytes), `privateKey` the scalar (32 bytes), both base64url. */
export interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

/** What the browser's `PushSubscription.toJSON()` gives: the endpoint and the user agent's keys, base64url. */
export interface PushSubscriptionJSON {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export type Urgency = "very-low" | "low" | "normal" | "high";

/** What a push service's answer means for the sender. */
export type PushOutcome =
	| { kind: "ok" }
	/** 404 / 410: the subscription is gone; delete it. */
	| { kind: "gone"; status: number }
	/** 429 / 5xx / a network fault: try again, no sooner than `afterMs` when the service said so. */
	| { kind: "retry"; status?: number; afterMs?: number }
	/** Anything else (400, 401, 403, 413…): this request is wrong; resending it unchanged will not help. */
	| { kind: "rejected"; status: number };

const RECORD_SIZE = 4096;
const KEY_LENGTH = 65;
const HEADER_LENGTH = 16 + 4 + 1 + KEY_LENGTH;
const TAG_LENGTH = 16;
/** The padded plaintext of every push (content + delimiter + zero padding): the body is always HEADER + this + tag. */
export const PADDED_PLAINTEXT_LENGTH = 1024;
/** Every push body is exactly this many bytes. */
export const PUSH_BODY_LENGTH = HEADER_LENGTH + PADDED_PLAINTEXT_LENGTH + TAG_LENGTH;
/** A VAPID JWT lives at most a day (RFC 8292 §2); banda signs for twelve hours. */
const JWT_LIFETIME_S = 12 * 60 * 60;

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
export const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

/** A fresh VAPID key pair. */
export function generateVapidKeys(): VapidKeys {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

function jwk(publicKey: Uint8Array, privateKey?: Uint8Array) {
	if (publicKey.length !== KEY_LENGTH || publicKey[0] !== 0x04)
		throw new Error("push: not an uncompressed P-256 point");
	return {
		kty: "EC",
		crv: "P-256",
		x: b64url(publicKey.subarray(1, 33)),
		y: b64url(publicKey.subarray(33, 65)),
		...(privateKey ? { d: b64url(privateKey) } : {}),
	};
}

/** The P-256 public key as a node KeyObject, for verifying a VAPID JWT. */
export function vapidPublicKeyObject(publicKey: string) {
	return createPublicKey({ key: jwk(fromB64url(publicKey)), format: "jwk" });
}

/**
 * An RFC 8292 VAPID JWT for one push service: `aud` is the endpoint's origin, `sub` a `mailto:` or `https:` URI the
 * service can reach the sender at, `exp` twelve hours from `now`.
 */
export function vapidJwt(args: { endpoint: string; subject: string; keys: VapidKeys; now?: number }): string {
	if (!/^(mailto:|https:)/.test(args.subject))
		throw new Error("push: the VAPID subject must be a mailto: or https: URI");
	const now = Math.floor((args.now ?? Date.now()) / 1000);
	const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = b64url(
		Buffer.from(JSON.stringify({ aud: new URL(args.endpoint).origin, exp: now + JWT_LIFETIME_S, sub: args.subject })),
	);
	const key = createPrivateKey({
		key: jwk(fromB64url(args.keys.publicKey), fromB64url(args.keys.privateKey)),
		format: "jwk",
	});
	const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
	return `${header}.${claims}.${b64url(signature)}`;
}

/** The `Authorization` header value (RFC 8292 §3): `vapid t=<jwt>, k=<public key>`. */
export function vapidAuthorization(args: { endpoint: string; subject: string; keys: VapidKeys; now?: number }): string {
	return `vapid t=${vapidJwt(args)}, k=${args.keys.publicKey}`;
}

const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
	Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/** RFC 8291 §3.4: the content-encryption key and nonce from the ECDH secret, both public keys, auth and salt. */
function deriveKeys(
	ecdhSecret: Uint8Array,
	uaPublic: Uint8Array,
	asPublic: Uint8Array,
	auth: Uint8Array,
	salt: Uint8Array,
) {
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
	const ikm = hkdf(auth, ecdhSecret, keyInfo, 32);
	return {
		cek: hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
		nonce: hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12),
	};
}

/**
 * Encrypts `plaintext` for one subscription (RFC 8291 over RFC 8188 aes128gcm), as a single final record padded with
 * `padding` zero bytes. `salt` and `serverPrivateKey` (the ephemeral key) are fresh unless given, which only a test
 * vector should do.
 */
export function encrypt(
	plaintext: Uint8Array,
	keys: { p256dh: string; auth: string },
	options: { padding?: number; salt?: Uint8Array; serverPrivateKey?: Uint8Array } = {},
): Buffer {
	const uaPublic = fromB64url(keys.p256dh);
	const auth = fromB64url(keys.auth);
	if (uaPublic.length !== KEY_LENGTH) throw new Error("push: p256dh is not a 65-byte P-256 point");
	if (auth.length !== 16) throw new Error("push: auth is not 16 bytes");
	const padding = options.padding ?? 0;
	if (plaintext.length + 1 + padding + TAG_LENGTH > RECORD_SIZE)
		throw new Error("push: the payload does not fit one record");
	const ecdh = createECDH("prime256v1");
	if (options.serverPrivateKey) ecdh.setPrivateKey(options.serverPrivateKey);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const salt = options.salt ? Buffer.from(options.salt) : randomBytes(16);
	const { cek, nonce } = deriveKeys(ecdh.computeSecret(uaPublic), uaPublic, asPublic, auth, salt);
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	// The last (and only) record ends its content with the delimiter 0x02, then zero padding (RFC 8188 §2).
	const record = Buffer.concat([plaintext, Buffer.from([0x02]), Buffer.alloc(padding)]);
	const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(HEADER_LENGTH);
	salt.copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header.writeUInt8(KEY_LENGTH, 20);
	asPublic.copy(header, 21);
	return Buffer.concat([header, ciphertext]);
}

/** The user agent's side of `encrypt`: what a browser does with a push body. Tests use it to read what was sent. */
export function decrypt(body: Uint8Array, keys: { privateKey: string; auth: string }): Buffer {
	const data = Buffer.from(body);
	if (data.length < HEADER_LENGTH + TAG_LENGTH) throw new Error("push: body too short");
	const salt = data.subarray(0, 16);
	const recordSize = data.readUInt32BE(16);
	const idLength = data.readUInt8(20);
	if (idLength !== KEY_LENGTH) throw new Error("push: keyid is not a P-256 point");
	const asPublic = data.subarray(21, 21 + KEY_LENGTH);
	const ciphertext = data.subarray(HEADER_LENGTH);
	if (ciphertext.length > recordSize) throw new Error("push: more than one record");
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(fromB64url(keys.privateKey));
	const { cek, nonce } = deriveKeys(
		ecdh.computeSecret(asPublic),
		ecdh.getPublicKey(),
		asPublic,
		fromB64url(keys.auth),
		salt,
	);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
	const record = Buffer.concat([
		decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)),
		decipher.final(),
	]);
	let end = record.length - 1;
	while (end >= 0 && record[end] === 0) end--;
	if (end < 0 || record[end] !== 0x02) throw new Error("push: not a final record");
	return record.subarray(0, end);
}

/**
 * The one plaintext banda pushes: a Declarative Web Push message (`web_push: 8030`) titled "<name> needs you" that
 * opens the app on tap, with `tag: "needs"` so a resend replaces the first. No other content: no ids, no text.
 */
export function needsYouMessage(name: string, badge?: number): string {
	const notification: Record<string, unknown> = { title: `${name} needs you`, navigate: "/#/", tag: "needs" };
	if (badge !== undefined) notification.app_badge = badge;
	return JSON.stringify({ web_push: 8030, notification });
}

/**
 * The plaintext of `needsYouMessage` and the zero padding that brings it to `PADDED_PLAINTEXT_LENGTH`, so every body is
 * `PUSH_BODY_LENGTH` bytes. A name too long to fit is cut, by code point, until it does.
 */
export function needsYouPayload(name: string, badge?: number): { plaintext: Buffer; padding: number } {
	let chars = Array.from(name);
	let plaintext = Buffer.from(needsYouMessage(name, badge));
	while (plaintext.length + 1 > PADDED_PLAINTEXT_LENGTH) {
		chars = chars.slice(0, -1);
		plaintext = Buffer.from(needsYouMessage(chars.join(""), badge));
	}
	return { plaintext, padding: PADDED_PLAINTEXT_LENGTH - plaintext.length - 1 };
}

export interface PushOptions {
	keys: VapidKeys;
	subject: string;
	/** Seconds the push service keeps an undelivered message (RFC 8030 §5.2). */
	ttl: number;
	urgency?: Urgency;
	/** Collapses an undelivered message with a newer one of the same topic (RFC 8030 §5.4): ≤32 base64url chars. */
	topic?: string;
	now?: number;
	/** Accept an `http:` endpoint: only for a local fake push service in tests. */
	allowHttp?: boolean;
}

/** The HTTP request that delivers `body` (already encrypted) to one subscription. */
export function pushRequest(
	subscription: PushSubscriptionJSON,
	body: Uint8Array,
	options: PushOptions,
): { url: string; method: "POST"; headers: Record<string, string>; body: Uint8Array } {
	if (new URL(subscription.endpoint).protocol !== "https:" && !options.allowHttp) {
		throw new Error("push: the endpoint is not https");
	}
	if (options.topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) {
		throw new Error("push: a topic is 1 to 32 base64url characters");
	}
	const headers: Record<string, string> = {
		Authorization: vapidAuthorization({
			endpoint: subscription.endpoint,
			subject: options.subject,
			keys: options.keys,
			now: options.now,
		}),
		"Content-Encoding": "aes128gcm",
		"Content-Type": "application/octet-stream",
		TTL: String(Math.max(0, Math.floor(options.ttl))),
		Urgency: options.urgency ?? "normal",
	};
	if (options.topic !== undefined) headers.Topic = options.topic;
	return { url: subscription.endpoint, method: "POST", headers, body };
}

/** What a push service's status (and `Retry-After`) means: ok, gone, retry, or rejected. */
export function classifyPushResponse(status: number, retryAfter?: string | null, now = Date.now()): PushOutcome {
	if (status >= 200 && status < 300) return { kind: "ok" };
	if (status === 404 || status === 410) return { kind: "gone", status };
	if (status === 429 || status >= 500) {
		const afterMs = parseRetryAfter(retryAfter, now);
		return afterMs === undefined ? { kind: "retry", status } : { kind: "retry", status, afterMs };
	}
	return { kind: "rejected", status };
}

/**
 * Sends "<name> needs you" to one subscription and classifies the answer. A network fault or timeout is a retry. The
 * caller owns retries, backoff and deleting a gone subscription.
 */
export async function sendPush(
	subscription: PushSubscriptionJSON,
	message: { name: string; badge?: number },
	options: PushOptions & { fetch?: typeof fetch; timeoutMs?: number },
): Promise<PushOutcome> {
	const { plaintext, padding } = needsYouPayload(message.name, message.badge);
	const body = encrypt(plaintext, subscription.keys, { padding });
	const request = pushRequest(subscription, body, options);
	const send = options.fetch ?? fetch;
	try {
		const response = await send(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
		});
		await response.arrayBuffer().catch(() => undefined);
		return classifyPushResponse(response.status, response.headers.get("retry-after"), options.now);
	} catch {
		return { kind: "retry" };
	}
}
