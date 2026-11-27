// Spike: key generation, export formats and signing.
// Stack A: @noble/curves + @noble/hashes + @scure/bip32 + @scure/bip39 (2.4.0) + micro-eth-signer 0.20.1
// Stack B: ox 1.8.20
// Third reference: Foundry's cast/anvil 1.9.0 (Rust, alloy + k256). No network but a local anvil.
//
//   ANVIL_URL=http://127.0.0.1:<port> ANVIL_CONFIG=<anvil --config-out file> node spike.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { addr, signTyped, Transaction, verifyTyped } from 'micro-eth-signer';
import { Address, Mnemonic, Secp256k1, Signature, TxEnvelopeEip1559, TxEnvelopeLegacy, TypedData } from 'ox';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const hex = (b) => `0x${bytesToHex(b)}`;
const N = secp256k1.Point.CURVE().n;
// ox returns lowercase addresses unless asked; banda compares and shows EIP-55 checksummed addresses only
const oxAddr = (privateKey) => Address.fromPublicKey(Secp256k1.getPublicKey({ privateKey }), { checksum: true });

// ---------------------------------------------------------------------------------------------------------------
console.log('\n## 1. Key generation and the raw-key export format');
{
  const RUNS = 2000;
  let agree = 0;
  let inRange = 0;
  let roundTrip = 0;
  for (let i = 0; i < RUNS; i++) {
    const sk = secp256k1.utils.randomSecretKey(); // CSPRNG: globalThis.crypto.getRandomValues
    const k = BigInt(hex(sk));
    if (sk.length === 32 && k > 0n && k < N) inRange++;
    const exported = hex(sk); // what the owner would save: 0x + 64 hex chars
    const a = addr.fromPrivateKey(exported);
    const b = oxAddr(exported);
    if (a === b) agree++;
    // re-import the exported string (as MetaMask/Rabby "import private key" would) and get the same account back
    const reimported = hexToBytes(exported.slice(2));
    if (addr.fromPrivateKey(reimported) === a && /^0x[0-9a-f]{64}$/.test(exported)) roundTrip++;
  }
  check(`noble randomSecretKey: ${RUNS} keys are 32 bytes in [1, n-1]`, inRange === RUNS, `${inRange}/${RUNS}`);
  check(`address from key: micro-eth-signer == ox for ${RUNS} random keys`, agree === RUNS, `${agree}/${RUNS}`);
  check(`raw export 0x+64hex re-imports to the same address`, roundTrip === RUNS, `${roundTrip}/${RUNS}`);
  // ox's own generator and micro-eth-signer's own generator, cross-derived
  const oxKey = Secp256k1.randomPrivateKey();
  const mesKey = addr.random();
  check('ox randomPrivateKey -> same address in micro-eth-signer', addr.fromPrivateKey(oxKey) === oxAddr(oxKey));
  check('micro-eth-signer addr.random -> same address in ox', oxAddr(mesKey.privateKey) === mesKey.address);
  // invalid keys are refused, not silently reduced
  for (const [label, bad] of [['zero', '0x' + '00'.repeat(32)], ['n', '0x' + N.toString(16)], ['31 bytes', '0x' + '11'.repeat(31)]]) {
    let a = false;
    let b = false;
    try { addr.fromPrivateKey(bad); } catch { a = true; }
    try { Secp256k1.getPublicKey({ privateKey: bad }); } catch { b = true; }
    check(`invalid key (${label}) refused by both`, a && b, `micro-eth-signer=${a} ox=${b}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n## 2. BIP-39 / BIP-32 against the official vectors (trezor/python-mnemonic vectors.json)');
{
  const vectors = [
    ['00000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04', 'xprv9s21ZrQH143K3h3fDYiay8mocZ3afhfULfb5GX8kCBdno77K4HiA15Tg23wpbeF1pLfs1c5SPmYHrEpTuuRhxMwvKDwqdKiGJS9XFKzUsAF'],
    ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow', '2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607', 'xprv9s21ZrQH143K2gA81bYFHqU68xz1cX2APaSq5tt6MFSLeXnCKV1RVUJt9FWNTbrrryem4ZckN8k4Ls1H6nwdvDTvnV7zEXs2HgPezuVccsq'],
    ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above', 'd71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8', 'xprv9s21ZrQH143K2shfP28KM3nr5Ap1SXjz8gc2rAqqMEynmjt6o1qboCDpxckqXavCwdnYds6yBHZGKHv7ef2eTXy461PXUjBFQg6PrwY4Gzq'],
    ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', 'ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069', 'xprv9s21ZrQH143K2V4oox4M8Zmhi2Fjx5XK4Lf7GKRvPSgydU3mjZuKGCTg7UPiBUD7ydVPvSLtg9hjp7MQTYsW67rZHAXeccqYqrsx8LcXnyd'],
  ];
  for (const [entropy, words, seed, xprv] of vectors) {
    const m = bip39.entropyToMnemonic(hexToBytes(entropy), wordlist);
    const s = bip39.mnemonicToSeedSync(words, 'TREZOR');
    const x = HDKey.fromMasterSeed(s).privateExtendedKey;
    const oxSeed = Mnemonic.toSeed(words, { passphrase: 'TREZOR' });
    check(`scure entropy->mnemonic, seed, xprv; ox seed: ${words.split(' ').slice(0, 2).join(' ')}…`, m === words && bytesToHex(s) === seed && x === xprv && bytesToHex(oxSeed) === seed);
  }
  // checksum: a one-word transcription error is caught by the phrase (a raw hex key has no checksum)
  const typo = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
  check('a mistyped last word fails the BIP-39 checksum (scure, ox)', !bip39.validateMnemonic(typo, wordlist) && !Mnemonic.validate(typo, Mnemonic.english));
}

// ---------------------------------------------------------------------------------------------------------------
console.log("\n## 3. BIP-44 m/44'/60'/0'/0/i from the anvil/Hardhat mnemonic vs anvil's own accounts");
const MNEMONIC = 'test test test test test test test test test test test junk';
const anvil = JSON.parse(readFileSync(process.env.ANVIL_CONFIG, 'utf8'));
{
  const seed = bip39.mnemonicToSeedSync(MNEMONIC);
  const master = HDKey.fromMasterSeed(seed);
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const path = `m/44'/60'/0'/0/${i}`;
    const scureKey = master.derive(path).privateKey;
    const scureAddr = addr.fromPrivateKey(scureKey);
    const oxKey = Mnemonic.toPrivateKey(MNEMONIC, { path, as: 'Hex' });
    const oxA = oxAddr(oxKey);
    if (scureAddr === oxA && scureAddr === Address.checksum(anvil.available_accounts[i]) && hex(scureKey) === anvil.private_keys[i] && oxKey === anvil.private_keys[i]) ok++;
    if (i === 0) {
      check('index 0 == 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (scure, ox, anvil)', scureAddr === '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' && oxA === scureAddr, scureAddr);
    }
  }
  check('indices 0..9: scure == ox == anvil (addresses and private keys)', ok === 10, `${ok}/10`);
  const castAddr = execFileSync('cast', ['wallet', 'address', '--mnemonic', MNEMONIC, '--mnemonic-index', '3']).toString().trim();
  check('index 3 == cast wallet address --mnemonic-index 3', castAddr === addr.fromPrivateKey(master.derive("m/44'/60'/0'/0/3").privateKey), castAddr);
  // Path conventions: MetaMask m/44'/60'/0'/0/i vs Ledger Live m/44'/60'/i'/0/0 agree only at i = 0
  const mm1 = addr.fromPrivateKey(master.derive("m/44'/60'/0'/0/1").privateKey);
  const ll1 = addr.fromPrivateKey(master.derive("m/44'/60'/1'/0/0").privateKey);
  const ll0 = addr.fromPrivateKey(master.derive("m/44'/60'/0'/0/0").privateKey);
  check('MetaMask and Ledger Live paths agree at index 0 and differ at index 1', ll0 === '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' && mm1 !== ll1, `MM[1]=${mm1.slice(0, 8)}… LL[1]=${ll1.slice(0, 8)}…`);
  // Cost of deriving from a stored phrase on every signature (PBKDF2-HMAC-SHA512, 2048 rounds)
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(MNEMONIC)).derive("m/44'/60'/0'/0/0");
  console.log(`      phrase -> key derivation: ${((performance.now() - t0) / 20).toFixed(1)} ms per key (n=20, this machine)`);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n## 4. EIP-155 legacy transaction vector (eips.ethereum.org/EIPS/eip-155)');
{
  const key = '0x' + '46'.repeat(32);
  const expected = '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83';
  const fields = { nonce: 9n, gasPrice: 20_000_000_000n, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n };
  const mes = Transaction.prepare({ type: 'legacy', ...fields, gasLimit: 21000n, chainId: 1n, data: '' }, false).signBy(key, false).toHex();
  const env = TxEnvelopeLegacy.from({ ...fields, gas: 21000n, chainId: 1 }); // ox: chainId is a number; 1n is refused
  const sig = Secp256k1.sign({ payload: TxEnvelopeLegacy.getSignPayload(env), privateKey: key });
  const ox = TxEnvelopeLegacy.serialize(env, { signature: sig });
  check('micro-eth-signer reproduces the EIP-155 signed tx', mes === expected);
  check('ox reproduces the EIP-155 signed tx', ox === expected);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n## 5. EIP-1559 transaction: byte-identical across micro-eth-signer, ox and cast; accepted by anvil');
const DEV_KEY = anvil.private_keys[0];
const DEV_ADDR = Address.checksum(anvil.available_accounts[0]);
const TO = Address.checksum(anvil.available_accounts[1]);
const tx1559 = { chainId: BigInt(anvil.chain_id ?? 31337), nonce: 0n, maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 3_000_000_000n, gasLimit: 21000n, to: TO, value: 10n ** 15n };
let rawSigned;
let rawHedged;
{
  const unsigned = Transaction.prepare({ type: 'eip1559', ...tx1559, data: '', accessList: [] });
  const mesDet = unsigned.signBy(DEV_KEY, false).toHex();
  const mesDet2 = unsigned.signBy(DEV_KEY, false).toHex();
  const mesHedgedA = unsigned.signBy(DEV_KEY).toHex(); // library default: extraEntropy = true
  const mesHedgedB = unsigned.signBy(DEV_KEY).toHex();
  const env = TxEnvelopeEip1559.from({ chainId: Number(tx1559.chainId), nonce: tx1559.nonce, maxPriorityFeePerGas: tx1559.maxPriorityFeePerGas, maxFeePerGas: tx1559.maxFeePerGas, gas: tx1559.gasLimit, to: TO, value: tx1559.value });
  const payload = TxEnvelopeEip1559.getSignPayload(env);
  const oxSig = Secp256k1.sign({ payload, privateKey: DEV_KEY }); // library default: extraEntropy = false
  const oxRaw = TxEnvelopeEip1559.serialize(env, { signature: oxSig });
  const oxRaw2 = TxEnvelopeEip1559.serialize(env, { signature: Secp256k1.sign({ payload, privateKey: DEV_KEY }) });
  // the bare noble call micro-eth-signer and ox both wrap: keccak digest, prehash off, RFC 6979, low-s
  const bare = secp256k1.sign(hexToBytes(payload.slice(2)), hexToBytes(DEV_KEY.slice(2)), { prehash: false, format: 'recovered' });
  const bareDefault = secp256k1.sign(hexToBytes(payload.slice(2)), hexToBytes(DEV_KEY.slice(2)), { format: 'recovered' }); // prehash: true by default
  const castRaw = execFileSync('cast', ['mktx', '--private-key', DEV_KEY, '--rpc-url', process.env.ANVIL_URL, '--chain', String(tx1559.chainId), '--nonce', '0', '--gas-limit', '21000', '--gas-price', String(tx1559.maxFeePerGas), '--priority-gas-price', String(tx1559.maxPriorityFeePerGas), '--value', String(tx1559.value), TO]).toString().trim();

  // ox's serialize splices the checksummed `to` into its hex string, so compare bytes, not strings
  const bytesEq = (x, y) => bytesToHex(hexToBytes(x.slice(2))) === bytesToHex(hexToBytes(y.slice(2)));
  check('ox serialize returns MIXED-CASE hex (the checksummed `to` spliced in): strings differ, bytes do not', oxRaw !== oxRaw.toLowerCase() && mesDet === mesDet.toLowerCase() && mesDet !== oxRaw);
  check('micro-eth-signer (extraEntropy=false) == ox (default) byte for byte', bytesEq(mesDet, oxRaw), `${oxRaw.length / 2 - 1} bytes`);
  check('== cast mktx (alloy, Rust) byte for byte (and as a lowercase string)', bytesEq(castRaw, oxRaw) && castRaw === mesDet);
  check('deterministic: signing twice gives the same bytes (both libraries)', mesDet === mesDet2 && oxRaw === oxRaw2);
  check('micro-eth-signer DEFAULT signBy is hedged: two signatures differ', mesHedgedA !== mesHedgedB);
  check('…and both hedged signatures recover the same sender', Transaction.fromHex(mesHedgedA).recoverSender().address === DEV_ADDR && Transaction.fromHex(mesHedgedB).recoverSender().address === DEV_ADDR);
  const s = BigInt(oxSig.s);
  check('signature is low-s (EIP-2)', s <= N / 2n);
  check('bare noble sign with prehash:false matches (r,s)', BigInt(hex(bare.slice(1, 33))) === BigInt(oxSig.r) && BigInt(hex(bare.slice(33, 65))) === s);
  check('bare noble sign with its DEFAULT prehash:true gives a different, wrong signature', BigInt(hex(bareDefault.slice(1, 33))) !== BigInt(oxSig.r));
  check('ox recovers the sender from the signed envelope', Address.isEqual(Secp256k1.recoverAddress({ payload, signature: oxSig }), DEV_ADDR));
  rawSigned = mesDet;
  rawHedged = mesHedgedB;

  // address handling: a mixed-case address with a broken checksum must be refused by both
  const li = [...TO].findIndex((c, i) => i > 1 && /[a-fA-F]/.test(c)); // flip the case of the first letter
  const badChecksum = TO.slice(0, li) + (TO[li] === TO[li].toUpperCase() ? TO[li].toLowerCase() : TO[li].toUpperCase()) + TO.slice(li + 1);
  let a = false;
  let b = false;
  try { Transaction.prepare({ type: 'eip1559', ...tx1559, to: badChecksum }); } catch { a = true; }
  try { Address.assert(badChecksum); } catch { b = true; }
  check('a broken EIP-55 checksum is refused (micro-eth-signer prepare, ox Address.assert)', a && b);
  let lowerOk = true;
  try { Transaction.prepare({ type: 'eip1559', ...tx1559, to: TO.toLowerCase() }); } catch { lowerOk = false; }
  let oxLowerOk = true;
  try { Address.assert(TO.toLowerCase()); } catch { oxLowerOk = false; }
  console.log(`      note: an all-lowercase address (no checksum to check) is accepted: micro-eth-signer=${lowerOk} ox=${oxLowerOk}`);
  // chainId defaults
  const noChain = Transaction.prepare({ type: 'eip1559', to: TO, value: 1n, maxFeePerGas: 3_000_000_000n, nonce: 0n });
  console.log(`      note: micro-eth-signer chainId when omitted: ${noChain.raw.chainId}`);
  let oxNoChain = 'from/assert accept it';
  try {
    const e0 = TxEnvelopeEip1559.from({ to: TO, value: 1n, maxFeePerGas: 3n, nonce: 0n });
    TxEnvelopeEip1559.assert(e0);
    TxEnvelopeEip1559.serialize(e0);
    oxNoChain += ', serialize accepts it';
  } catch (e) { oxNoChain += `, serialize throws ${e.name}: ${(e.shortMessage ?? e.message).split('\n')[0]}`; }
  console.log(`      note: ox chainId omitted: ${oxNoChain}`);
}
{
  const rpc = async (method, params) => (await (await fetch(process.env.ANVIL_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  await rpc('anvil_reset', []); // the tx uses nonce 0: start from genesis so the spike can be rerun on one anvil
  const sent = await rpc('eth_sendRawTransaction', [rawSigned]);
  const expectedHash = hex(keccak_256(hexToBytes(rawSigned.slice(2))));
  check('anvil accepts the raw tx; hash == keccak(raw bytes)', sent.result === expectedHash, sent.result ?? JSON.stringify(sent.error));
  const receipt = (await rpc('eth_getTransactionReceipt', [expectedHash])).result;
  check('receipt: status 1, from == derived address', receipt?.status === '0x1' && Address.checksum(receipt.from) === DEV_ADDR, `block ${Number(receipt?.blockNumber)}`);
  const again = await rpc('eth_sendRawTransaction', [rawSigned]);
  console.log(`      resend of the same bytes after mining: ${again.result ? 'result ' + again.result : 'error "' + again.error?.message + '"'}`);
  // a hedged re-signature of the same payment (what a re-sign after a crash would make) has another hash,
  // and the nonce, not the signature, is what stops it from paying twice
  const hedgedHash = hex(keccak_256(hexToBytes(rawHedged.slice(2))));
  const second = await rpc('eth_sendRawTransaction', [rawHedged]);
  check('hedged re-signature of the same tx: different hash, refused by the nonce once the first is mined', hedgedHash !== expectedHash && !second.result, `error "${second.error?.message}"`);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\n## 6. EIP-712: the EIP\'s own Mail vector, and EIP-3009 TransferWithAuthorization (x402 exact, USDC Base Sepolia)');
const tmp = mkdtempSync(join(tmpdir(), 'spike-712-'));
try {
  const mail = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Person: [{ name: 'name', type: 'string' }, { name: 'wallet', type: 'address' }],
      Mail: [{ name: 'from', type: 'Person' }, { name: 'to', type: 'Person' }, { name: 'contents', type: 'string' }],
    },
    primaryType: 'Mail',
    domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
    message: { from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' }, to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' }, contents: 'Hello, Bob!' },
  };
  const cow = hex(keccak_256(utf8ToBytes('cow')));
  const expectedSig = '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c'; // r || s || v=28
  check('ox TypedData.getSignPayload == 0xbe609aee…7bd2 (the EIP\'s signHash)', TypedData.getSignPayload(mail) === '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');
  const mesMail = signTyped(mail, cow, false);
  const oxMail = Signature.toHex(Secp256k1.sign({ payload: TypedData.getSignPayload(mail), privateKey: cow }));
  check('micro-eth-signer signTyped(extraEntropy=false) == EIP-712 vector (v=28, r, s)', mesMail === expectedSig);
  check('ox sign(getSignPayload) == EIP-712 vector', oxMail === expectedSig);
  check('micro-eth-signer signTyped DEFAULT is hedged (differs from the vector), still verifies', signTyped(mail, cow) !== expectedSig && verifyTyped(signTyped(mail, cow), mail, '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'));

  const auth3009 = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
    },
    primaryType: 'TransferWithAuthorization',
    domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    message: { from: DEV_ADDR, to: TO, value: '10000', validAfter: '0', validBefore: '1795440000', nonce: '0x' + 'ab'.repeat(32) },
  };
  const mes3009 = signTyped(auth3009, DEV_KEY, false);
  const ox3009 = Signature.toHex(Secp256k1.sign({ payload: TypedData.getSignPayload(auth3009), privateKey: DEV_KEY }));
  const f = join(tmp, 'auth3009.json');
  writeFileSync(f, JSON.stringify(auth3009));
  const cast3009 = execFileSync('cast', ['wallet', 'sign', '--private-key', DEV_KEY, '--data', '--from-file', f]).toString().trim();
  const castMailF = join(tmp, 'mail.json');
  writeFileSync(castMailF, JSON.stringify(mail));
  const castMail = execFileSync('cast', ['wallet', 'sign', '--private-key', cow, '--data', '--from-file', castMailF]).toString().trim();
  check('cast wallet sign --data reproduces the EIP-712 Mail vector', castMail === expectedSig);
  check('EIP-3009 authorization: micro-eth-signer == ox == cast', mes3009 === ox3009 && ox3009 === cast3009, ox3009.slice(0, 18) + '…');
  check('EIP-3009 authorization recovers to the wallet (ox)', Address.isEqual(Secp256k1.recoverAddress({ payload: TypedData.getSignPayload(auth3009), signature: Signature.fromHex(ox3009) }), DEV_ADDR));
  // the same message under Base mainnet's domain name gives a different signature (x402 research: "USD Coin" vs "USDC")
  const mainnetName = Signature.toHex(Secp256k1.sign({ payload: TypedData.getSignPayload({ ...auth3009, domain: { ...auth3009.domain, name: 'USD Coin' } }), privateKey: DEV_KEY }));
  check('domain name "USD Coin" vs "USDC" changes the signature (pinned per-chain table needed)', mainnetName !== ox3009);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
