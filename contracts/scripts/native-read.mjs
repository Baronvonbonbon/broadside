#!/usr/bin/env node
// Read a contract the way the Polkadot App will have to: Substrate RPC and the
// `ReviveApi` runtime API, with no eth-rpc anywhere.
//
//   node contracts/scripts/native-read.mjs [--ws <endpoint>]
//
// This is the transport the host-routed client is forced into. The host blocks
// `eth_*` outright and allows only the modern JSON-RPC spec, so a Product that
// wants to read a contract without an external endpoint has exactly one door:
// `chainHead_v1_call` carrying a SCALE-encoded `ReviveApi_call`. This script
// drives the same runtime API over a plain `state_call`, which is available on
// a public RPC and not on the host — so it proves the *encoding* and the
// *decoding* independently of the subscription plumbing PAPI will handle.
//
// What it does not prove: the chainHead follow/operation lifecycle. That is
// PAPI's job and belongs in packages/client.

import fs from "node:fs";
import path from "node:path";
import { Interface } from "ethers";

const HERE = import.meta.dirname;
const CONTRACTS = path.resolve(HERE, "..");

// devnet-asset-hub in @parity/product-sdk-descriptors — which is Paseo Asset
// Hub, parachain 1000. The naming is the platform's, not ours, and it is worth
// stating plainly because it is genuinely confusing: the descriptor called
// `paseo-asset-hub` is a *different*, newer chain ("Paseo Next v2") that the
// current host build does not carry.
const DEFAULT_WS = "wss://asset-hub-paseo-rpc.n.dwellir.com";
const EXPECTED_GENESIS = "0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const WS = arg("--ws", process.env.BROADSIDE_WS ?? DEFAULT_WS);

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// ── SCALE, only the parts this needs ────────────────────────────────────────

const bytesToHex = (b) => "0x" + Buffer.from(b).toString("hex");
const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const concat = (...xs) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

function encodeCompact(n) {
  const v = BigInt(n);
  if (v < 64n) return Uint8Array.from([Number(v) << 2]);
  if (v < 16384n) {
    const x = (Number(v) << 2) | 0b01;
    return Uint8Array.from([x & 0xff, x >> 8]);
  }
  if (v < 1073741824n) {
    const x = (Number(v) << 2) | 0b10;
    return Uint8Array.from([x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff]);
  }
  const bytes = [];
  let r = v;
  while (r > 0n) {
    bytes.push(Number(r & 0xffn));
    r >>= 8n;
  }
  return Uint8Array.from([((bytes.length - 4) << 2) | 0b11, ...bytes]);
}

/** @returns [value, bytesRead] */
function decodeCompact(data, o = 0) {
  const b = data[o];
  const mode = b & 3;
  if (mode === 0) return [b >> 2, 1];
  if (mode === 1) return [((data[o] | (data[o + 1] << 8)) >>> 2), 2];
  if (mode === 2) return [((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 2), 4];
  const n = (b >> 2) + 4;
  let v = 0n;
  for (let i = n; i >= 1; i--) v = (v << 8n) | BigInt(data[o + i]);
  return [Number(v), n + 1];
}

const encodeU128 = (v) => {
  const out = new Uint8Array(16);
  let r = BigInt(v);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(r & 0xffn);
    r >>= 8n;
  }
  return out;
};

const encodeBytes = (b) => concat(encodeCompact(b.length), b);

/**
 * pallet-revive's origin is an AccountId32. An Ethereum-derived account is
 * encoded as its 20 H160 bytes followed by twelve 0xEE — the runtime's marker
 * for "this account came from an H160, not a sr25519 key".
 */
function encodeOrigin(h160) {
  const out = new Uint8Array(32).fill(0xee);
  out.set(hexToBytes(h160), 0);
  return out;
}

/** ContractResult → the contract's return bytes. Layout per pine-rpc, which verified it byte-for-byte against a live call. */
function extractOutput(data) {
  let o = 0;
  const skip = () => {
    o += decodeCompact(data, o)[1];
  };
  skip(); skip(); // weightConsumed  { refTime, proofSize }
  skip(); skip(); // weightRequired  { refTime, proofSize }
  o += 1 + 16;    // storageDeposit     variant + u128
  o += 1 + 16;    // maxStorageDeposit  variant + u128
  o += 16;        // gasConsumed        u128

  if (o >= data.length) throw new Error("ContractResult overran its preamble — runtime layout drift");
  const variant = data[o++];
  if (variant === 1) throw new Error(`the call reverted: ${bytesToHex(data.slice(o)).slice(0, 80)}`);
  if (variant !== 0) throw new Error(`unexpected ContractResult variant ${variant}`);

  o += 4; // ExecReturnValue.flags — u32 LE
  const [len, n] = decodeCompact(data, o);
  o += n;
  return bytesToHex(data.slice(o, o + len));
}

// ── transport ───────────────────────────────────────────────────────────────

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 1;
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error(`websocket failed: ${e.message ?? e.type}`));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const settle = pending.get(m.id);
    if (settle) {
      pending.delete(m.id);
      settle(m);
    }
  };
  return {
    ready,
    call(method, params = []) {
      const i = id++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(i);
          reject(new Error(`${method} did not answer in 20 s`));
        }, 20_000);
        pending.set(i, (m) => {
          clearTimeout(timer);
          if (m.error) reject(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`));
          else resolve(m.result);
        });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

// ── the checks ──────────────────────────────────────────────────────────────

const artifact = JSON.parse(fs.readFileSync(path.join(CONTRACTS, "out", "BroadsideSeam.json"), "utf8"));
const bookPath = path.join(CONTRACTS, "deployed-addresses.json");
if (!fs.existsSync(bookPath)) fail("Not deployed — run contracts/scripts/deploy.mjs first.");
const book = JSON.parse(fs.readFileSync(bookPath, "utf8")).BroadsideSeam;

const iface = new Interface(artifact.abi);
let failures = 0;
const check = (label, pass, detail = "") => {
  console.log(`  ${pass ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!pass) failures++;
};

const rpc = connect(WS);
await rpc.ready;

console.log(`\nNative read — no eth-rpc\n  endpoint ${WS}\n  contract ${book.address}\n`);

const genesis = await rpc.call("chain_getBlockHash", [0]);
check(
  "chain is the one the host carries",
  genesis.toLowerCase() === EXPECTED_GENESIS,
  `genesis ${genesis.slice(0, 14)}… (descriptor: devnet-asset-hub)`,
);

// ── the deployed blob is ours, byte for byte ────────────────────────────────
const codeRaw = hexToBytes(await rpc.call("state_call", ["ReviveApi_code", book.address.toLowerCase()]));
const [codeLen, lenBytes] = decodeCompact(codeRaw, 0);
const code = codeRaw.slice(lenBytes, lenBytes + codeLen);

check("ReviveApi_code returned a blob", codeLen > 0, `${codeLen.toLocaleString()} bytes`);
// "PVM\0" — the PolkaVM container magic. An EVM deployment would not have it,
// so this is what distinguishes a native blob from compatibility-mode bytecode.
check(
  "the blob is native PolkaVM",
  bytesToHex(code.slice(0, 4)) === "0x50564d00",
  `magic ${bytesToHex(code.slice(0, 4))} = "PVM\\0"`,
);
check(
  "it matches the local artifact exactly",
  bytesToHex(code) === artifact.pvm.bytecode.toLowerCase(),
  `${artifact.pvm.bytes.toLocaleString()} bytes`,
);

// ── an actual contract call, through ReviveApi_call ─────────────────────────
//
// The origin is the zero address. pallet-revive refuses contract calls from an
// unmapped AccountId32 — FARE hit that and it shapes client design — so whether
// an eth-derived zero origin is accepted is exactly the question, and it is
// cheaper to ask than to reason about.
async function reviveCall(origin, data) {
  const encoded = concat(
    encodeOrigin(origin),
    hexToBytes(book.address),
    encodeU128(0n),
    Uint8Array.from([0]), // gas_limit = None
    Uint8Array.from([0]), // storage_deposit_limit = None
    encodeBytes(hexToBytes(data)),
  );
  return extractOutput(hexToBytes(await rpc.call("state_call", ["ReviveApi_call", bytesToHex(encoded)])));
}

const ZERO = "0x0000000000000000000000000000000000000000";
try {
  const out = await reviveCall(ZERO, iface.encodeFunctionData("chainId", []));
  const reported = Number(iface.decodeFunctionResult("chainId", out)[0]);
  check("ReviveApi_call executed a view function", true, `chainId() = ${reported}`);
  check("it agrees with the recorded deployment", reported === book.chainId, `book says ${book.chainId}`);
  check(
    "an unmapped zero origin can read",
    true,
    "so a Product needs no mapped account for view calls — the anonymous-read constraint does not bite here",
  );
} catch (e) {
  check("ReviveApi_call executed a view function", false, e.message);
  if (/AccountUnmapped|Unmapped/i.test(e.message)) {
    console.log(
      "\n  → The zero origin is unmapped. Reads need one well-known mapped account as the\n" +
        "    origin for every view call; a dry-run's origin is never published, so this\n" +
        "    costs privacy nothing. See fare/docs/SUBSTRATE-NATIVE-SPIKE.md finding 2.",
    );
  }
}

rpc.close();
console.log(failures ? `\n✗ ${failures} check(s) failed\n` : `\n✓ all checks passed — the host-routed read path works without eth-rpc\n`);
process.exit(failures ? 1 : 0);
