/**
 * Signing a Seam, and asking the contract who signed it.
 *
 * The EIP-712 domain and type table come from the artifact, which got them from
 * `contracts/src/BroadsideSeam.types.json` — the same file the contract test
 * asserts the Solidity typehash literals against. That chain matters more than
 * it looks: a typehash that differs by one character produces signatures that
 * are well-formed, recoverable, and recover to the wrong address, with no error
 * anywhere. It simply never matches, and there is nothing to debug.
 */

import {
  Interface,
  TypedDataEncoder,
  Wallet,
  getBytes,
  hexlify,
  randomBytes,
  recoverAddress,
} from "ethers";
import artifact from "./generated/seam.json";

export interface SeamValue {
  viewer: string;
  nonce: bigint;
  note: string;
}

export interface SignedSeam {
  value: SeamValue;
  signature: string;
  /** What the client computed the digest to be, for comparison with the chain's. */
  localDigest: string;
  /** Recovery done locally — proves the signature is self-consistent before any RPC. */
  localRecovered: string;
}

const iface = new Interface(artifact.abi);

export const CONTRACT_ADDRESS = artifact.address;
export const CONTRACT_CHAIN_ID = artifact.chainId;
export const CONTRACT_TARGET = artifact.target;

export function domain(chainId: number, verifyingContract: string) {
  if (!artifact.eip712) throw new Error("artifact carries no eip712 block — rebuild the contracts");
  return {
    name: artifact.eip712.domain.name,
    version: artifact.eip712.domain.version,
    chainId,
    verifyingContract,
  };
}

export const types = () => {
  if (!artifact.eip712) throw new Error("artifact carries no eip712 block — rebuild the contracts");
  return artifact.eip712.types as Record<string, { name: string; type: string }[]>;
};

/** A fresh note per run, so two runs never collide on the contract's nonce guard. */
export function freshSeam(viewer: string, nonce: bigint): SeamValue {
  return { viewer, nonce, note: hexlify(randomBytes(32)) };
}

export async function signSeam(
  wallet: Wallet,
  value: SeamValue,
  chainId: number,
  verifyingContract: string,
): Promise<SignedSeam> {
  const d = domain(chainId, verifyingContract);
  const t = types();
  const signature = await wallet.signTypedData(d, t, value);
  return {
    value,
    signature,
    localDigest: TypedDataEncoder.hash(d, t, value),
    localRecovered: recoverLocally(d, t, value, signature),
  };
}

function recoverLocally(
  d: ReturnType<typeof domain>,
  t: ReturnType<typeof types>,
  value: SeamValue,
  signature: string,
): string {
  // ethers offers verifyTypedData, which does both steps at once. Hashing and
  // recovering separately keeps this symmetric with what the contract does, so
  // a mismatch localises to the digest or to the recovery rather than to
  // "ethers disagrees with Solidity".
  return recoverAddress(TypedDataEncoder.hash(d, t, value), signature);
}

/** Calldata for `recover(Seam,bytes) view returns (address)`. */
export function encodeRecover(value: SeamValue, signature: string): string {
  return iface.encodeFunctionData("recover", [[value.viewer, value.nonce, value.note], signature]);
}

/** Calldata for `attest(Seam,bytes)`. */
export function encodeAttest(value: SeamValue, signature: string): string {
  return iface.encodeFunctionData("attest", [[value.viewer, value.nonce, value.note], signature]);
}

export function encodeChainId(): string {
  return iface.encodeFunctionData("chainId", []);
}

export function encodeDomainSeparator(): string {
  return iface.encodeFunctionData("domainSeparator", []);
}

/**
 * Decode a return value, turning a revert into something readable.
 *
 * The contract reverts with a named error for each distinct failure —
 * `MalleableSignature`, `RecoveryFailed`, `ViewerMismatch` — precisely so a
 * probe can tell them apart. Collapsing them back into "call failed" here would
 * throw away the reason they exist.
 */
export function decodeResult(fn: string, data: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!data || data === "0x") return { ok: false, error: "empty return — call reverted without data, or the address holds no code" };
  try {
    const decoded = iface.decodeFunctionResult(fn, data);
    return { ok: true, value: decoded.length === 1 ? decoded[0] : decoded.toArray() };
  } catch {
    try {
      const err = iface.parseError(data);
      if (err) return { ok: false, error: `${err.name}(${err.args.map(String).join(", ")})` };
    } catch {
      // Not one of ours — fall through to the raw bytes, which is still more
      // useful than "decode failed".
    }
    return { ok: false, error: `undecodable return: ${data.slice(0, 74)}${data.length > 74 ? "…" : ""}` };
  }
}

export function toHex(bytes: Uint8Array): string {
  return hexlify(bytes);
}

export function fromHex(hex: string): Uint8Array {
  return getBytes(hex);
}
