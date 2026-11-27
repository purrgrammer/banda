// Spike SEC-M1: does the hex key read from the keychain stay in the V8 heap after use, refs dropped, and after gc()?
// "string": getPassword (a JS string); "bytes": getSecret (an Array<number>, zeroed after use). Dummy random value, never funded.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { writeHeapSnapshot } from "node:v8";
import { readFileSync, unlinkSync } from "node:fs";
const require = createRequire(process.env.DEPS + "/package.json");
const { Entry } = require("@napi-rs/keyring");
const { secp256k1 } = await import(require.resolve("@noble/curves/secp256k1.js"));
const { keccak_256 } = await import(require.resolve("@noble/hashes/sha3.js"));
const mode = process.argv[2];
const service = "banda-spike-" + randomBytes(6).toString("hex");
const e = new Entry(service, "spike");
// store, keeping only the two halves of the hex (never the whole) as the needle
const needle = (() => {
  const raw = randomBytes(32);
  const halves = [raw.subarray(0, 16).toString("hex"), raw.subarray(16).toString("hex")];
  if (mode !== "bytes") e.setPassword(raw.toString("hex")); else e.setSecret(new Uint8Array(raw));
  raw.fill(0);
  return halves;
})();
(() => {
  let key;
  if (mode === "string" || mode === "control") { const s = e.getPassword(); if (mode === "control") globalThis.leak = s; key = Uint8Array.from(Buffer.from(s, "hex")); }
  else { const arr = e.getSecret(); key = Uint8Array.from(arr); arr.fill(0); }
  secp256k1.sign(keccak_256(new TextEncoder().encode("spike")), key, { prehash: false });
  key.fill(0);
})();
e.deletePassword();
const scan = (label) => {
  const file = writeHeapSnapshot(`${process.env.OUT}/heap-${mode}-${label}-${process.pid}.heapsnapshot`);
  const text = readFileSync(file, "latin1");
  const found = text.indexOf(needle[0] + needle[1]) !== -1;
  unlinkSync(file);
  return found;
};
const before = scan("nogc");
for (let i = 0; i < 5; i++) global.gc();
const after = scan("gc");
console.log(JSON.stringify({ mode, hexInHeapBeforeGc: before, hexInHeapAfterGc: after }));
