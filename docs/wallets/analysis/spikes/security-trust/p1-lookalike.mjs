// Spike SEC-P1: (a) EIP-55: an all-lowercase address carries no checksum, so it cannot catch a typo; a wrong mixed-case one can.
// (b) look-alike: how fast does plain CPU keygen find an address whose first k and last k hex digits match a target,
// and does a full-address + prefix/suffix gate flag it?
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
const require = createRequire(process.env.DEPS + "/package.json");
const { secp256k1 } = await import(require.resolve("@noble/curves/secp256k1.js"));
const { keccak_256 } = await import(require.resolve("@noble/hashes/sha3.js"));
const hex = (b) => Buffer.from(b).toString("hex");
const addr = (sk) => hex(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1)).subarray(12));
const checksum = (a) => { const h = hex(keccak_256(new TextEncoder().encode(a))); return "0x" + [...a].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join(""); };
const valid = (s) => { if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return "malformed"; const b = s.slice(2); if (b === b.toLowerCase() || b === b.toUpperCase()) return "no-checksum"; return checksum(b.toLowerCase()) === s ? "checksummed" : "bad-checksum"; };
const target = addr(secp256k1.utils.randomSecretKey());
const good = checksum(target);
const typo = good.slice(0, 10) + (good[10] === "a" ? "b" : "a") + good.slice(11);
const flip = good.slice(0, 2) + [...good.slice(2)].map((c, i) => (i === 5 && /[a-f]/i.test(c) ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c)).join("");
console.log(JSON.stringify({ eip55: { good: valid(good), lowercaseTypo: valid(typo.toLowerCase()), mixedTypo: valid(typo), caseFlip: valid(flip) } }));
const lookalike = (a, b, k) => a !== b && a.slice(0, k) === b.slice(0, k) && a.slice(-k) === b.slice(-k);
for (const k of [1, 2]) {
  const t0 = Date.now(); let n = 0, found;
  while (!found) { n++; const a = addr(secp256k1.utils.randomSecretKey()); if (lookalike(a, target, k)) found = a; }
  console.log(JSON.stringify({ k, tries: n, ms: Date.now() - t0, flaggedByGate: lookalike(found, target, k), equalAsIdentity: found === target }));
}
