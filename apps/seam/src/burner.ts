/**
 * The app-local signing key.
 *
 * The Polkadot App signs sr25519 and cannot produce an ecrecover-able
 * signature, and AutoSigning reports NotAvailable on both mobile wallets, so
 * every host-routed signature costs a user tap. An ad network cannot tap-sign
 * per impression. That is what forces a secp256k1 key held by the app itself —
 * this is not a shortcut around the host signer, it is the only path.
 *
 * What makes it tolerable is that `deriveEntropy` is deterministic: the key is
 * regenerated on demand from the host's own entropy, so there is no seed to
 * back up, nothing to export, and nothing to lose. Whether that determinism
 * actually holds in a *published* bundle is one of the five things this probe
 * is here to find out — everything below assumes it and the checks test it.
 */

import { deriveEntropy } from "@parity/product-sdk-host";
import { Wallet, concat, keccak256, toUtf8Bytes } from "ethers";
import { KEY_DOMAIN } from "../product.mjs";

export interface Burner {
  wallet: Wallet;
  address: string;
  /** keccak of the raw entropy — comparable across runs without publishing it. */
  entropyFingerprint: string;
}

export class HostEntropyError extends Error {
  constructor(readonly reason: string) {
    super(`deriveEntropy failed: ${reason}`);
    this.name = "HostEntropyError";
  }
}

/** Raw host entropy for a label. Kept separate so a check can compare two labels. */
export async function hostEntropy(label: string): Promise<Uint8Array> {
  const r = await deriveEntropy(toUtf8Bytes(label));
  if (!r.ok) throw new HostEntropyError(describe(r.error));
  return r.value;
}

/**
 * Entropy → signing key.
 *
 * The key is `keccak256(entropy ‖ KEY_DOMAIN)` rather than the entropy itself.
 * Two reasons, and the second is the one that matters: a raw 32-byte value is
 * not guaranteed to be a valid secp256k1 scalar, and more importantly, using
 * the host's entropy directly would mean any other Broadside surface asking for
 * the same label derives the same key. The domain tag is what keeps the seam
 * probe's key distinct from the widget's.
 */
export function keyFromEntropy(entropy: Uint8Array): Wallet {
  return new Wallet(keccak256(concat([entropy, toUtf8Bytes(KEY_DOMAIN)])));
}

export async function deriveBurner(label: string): Promise<Burner> {
  const entropy = await hostEntropy(label);
  const wallet = keyFromEntropy(entropy);
  return {
    wallet,
    address: wallet.address,
    // The report is meant to be shared and diffed. The address is a
    // per-product pseudonym with no link to the user's account, so publishing
    // it is exactly what the design claims is safe — but the entropy it came
    // from is key material, so only its hash travels.
    entropyFingerprint: keccak256(entropy),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const s = JSON.stringify(error);
    if (s && s !== "{}") return s.slice(0, 200);
  }
  return String(error);
}
