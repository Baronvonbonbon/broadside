/**
 * Every way a Product might read a contract, tried side by side.
 *
 * Nine runs were spent testing one path at a time and reasoning about why it
 * did not work. This does the opposite: each candidate is attempted under its
 * own deadline, and the whole matrix is reported whatever happens. A path that
 * fails is as informative as one that works, and *which* paths fail together is
 * more informative than either.
 *
 * The candidates are not guesses. `@parity/product-sdk-contracts` documents the
 * intended pattern in its own examples:
 *
 *   const runtime = createContractRuntimeFromClient(rawClient, paseo_asset_hub);
 *   const counter  = createContract(runtime, "0xC472…", abi);
 *   await counter.getCount.query();
 *
 * That matters for the thing this probe kept failing to do by hand. The host
 * allows `chainHead_v1_call` but its result returns as a notification on a
 * follow subscription, not as a reply — a lifecycle a hand-rolled JSON-RPC
 * client cannot drive. PAPI drives it, and these SDK paths sit on PAPI. So the
 * question is not whether the lifecycle can be implemented; it is whether the
 * supported client already does it inside this host.
 */

import type { App } from "@parity/product-sdk";
import { createContract, createContractFromClient, createContractRuntime } from "@parity/product-sdk-contracts";
import { devnet_asset_hub } from "@parity/product-sdk-descriptors/devnet-asset-hub";

import { ETH_RPC_URL } from "../product.mjs";
import { ethCall } from "./chain";
import { CONTRACT_ADDRESS, decodeResult, encodeChainId } from "./seam";
import artifact from "./generated/seam.json";

export interface PathResult {
  /** What was tried, in a form a reader can map back to SDK documentation. */
  path: string;
  ok: boolean;
  /** The decoded `chainId()` return, when the path produced one. */
  value?: string;
  error?: string;
  ms: number;
  /** True when the deadline fired rather than the call returning. */
  timedOut?: boolean;
}

/**
 * Run a path under its own deadline.
 *
 * The deadline does not cancel the work — nothing here can, short of an
 * AbortController the SDK does not expose — but it does guarantee the matrix
 * moves on. One path that never settles must not cost the answers from the
 * other four, which is exactly what happened when they were tried one per run.
 */
async function timeboxed(path: string, ms: number, fn: () => Promise<string>): Promise<PathResult> {
  const t0 = performance.now();
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`deadline: no answer in ${ms} ms`)), ms),
  );
  try {
    const value = await Promise.race([fn(), deadline]);
    return { path, ok: true, value, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      path,
      ok: false,
      error: error.slice(0, 300),
      ms: Math.round(performance.now() - t0),
      timedOut: error.startsWith("deadline:"),
    };
  }
}

/** `chainId()` is the read under test everywhere: no arguments, one word back, and
 *  a value we can check against the deployment record rather than merely observe. */
const CHAIN_ID_ABI = artifact.abi;

/** Normalise whatever a path returns into a comparable string. */
const asText = (v: unknown): string => (typeof v === "bigint" ? v.toString() : String(v));

export async function runReadPaths(app: App | undefined, deadlineMs = 20_000): Promise<PathResult[]> {
  const results: PathResult[] = [];
  const address = CONTRACT_ADDRESS as `0x${string}`;

  // ── A. The documented SDK path, through app.chain.connect ─────────────────
  results.push(
    await timeboxed("A · app.chain.connect + createContractRuntime", deadlineMs, async () => {
      if (!app) throw new Error("no App — createApp did not produce one");
      const client = (await app.chain.connect({ assetHub: devnet_asset_hub })) as Record<string, unknown>;
      const contract = createContract(createContractRuntime(client.assetHub as never), address, CHAIN_ID_ABI as never);
      const r = await (contract as Record<string, { query(): Promise<{ value: unknown }> }>).chainId.query();
      return asText(r.value);
    }),
  );

  // ── B. The raw-client path the SDK recommends for production ──────────────
  //
  // Its own docs prefer this over A: the runtime-API dry-run is not tolerant of
  // descriptor drift on PAPI's compat-token path, and this route bypasses the
  // compat check via getUnsafeApi while preserving argument and return shapes.
  results.push(
    await timeboxed("B · app.chain.getRawClient + createContractFromClient", deadlineMs, async () => {
      if (!app) throw new Error("no App — createApp did not produce one");
      const raw = app.chain.getRawClient(devnet_asset_hub as never);
      const contract = createContractFromClient(raw, devnet_asset_hub, address, CHAIN_ID_ABI as never);
      const r = await (contract as Record<string, { query(): Promise<{ value: unknown }> }>).chainId.query();
      return asText(r.value);
    }),
  );

  // ── C. Same as B, but connect() first ─────────────────────────────────────
  //
  // getRawClient's own contract says the chain must be connected first. If B
  // fails and C succeeds, the fault is ordering rather than transport — a
  // distinction worth one extra call to establish.
  results.push(
    await timeboxed("C · connect() then getRawClient", deadlineMs, async () => {
      if (!app) throw new Error("no App — createApp did not produce one");
      await app.chain.connect({ assetHub: devnet_asset_hub });
      const raw = app.chain.getRawClient(devnet_asset_hub as never);
      const contract = createContractFromClient(raw, devnet_asset_hub, address, CHAIN_ID_ABI as never);
      const r = await (contract as Record<string, { query(): Promise<{ value: unknown }> }>).chainId.query();
      return asText(r.value);
    }),
  );

  // ── D. The external endpoint — the control ────────────────────────────────
  //
  // Known to work from Node and reachable from inside the WebView. Its job here
  // is to separate "this contract/calldata is wrong" from "the host route is
  // wrong"; if D fails too, nothing above it can be trusted as a host finding.
  results.push(
    await timeboxed("D · external eth-rpc (control)", deadlineMs, async () => {
      if (!ETH_RPC_URL) throw new Error("ETH_RPC_URL not configured");
      const r = await ethCall(ETH_RPC_URL, address, encodeChainId(), Math.min(deadlineMs, 10_000));
      if (!r.ok) throw new Error(r.error?.message ?? "call failed");
      const decoded = decodeResult("chainId", String(r.result));
      if (!decoded.ok) throw new Error(decoded.error);
      return asText(decoded.value);
    }),
  );

  return results;
}
