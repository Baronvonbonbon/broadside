/**
 * Claim envelope and its EIP-712 binding.
 *
 * Ported from DATUM's SLIM claim format (`alpha-core/contracts/interfaces/
 * IDatumSettlement.sol`, mirrored in `datum-labs/relay/src/abis.mjs`). The
 * struct is unchanged; only the domain name moves, which is a deliberate
 * break — Broadside is a clean-break deploy and must not accept a signature
 * that was ever valid against DATUM.
 *
 * The three signatures are the whole fraud model. Publisher and advertiser
 * have opposing economic interests, so a claim carrying both is one neither
 * side can unilaterally invent; the user's signature is what makes it theirs.
 * Contracts additionally reject the case where publisher and advertiser
 * signatures recover to the same key (DATUM's E89 independence guard) — that
 * collapse is what makes the adverse-interest argument load-bearing rather
 * than decorative.
 */

export const EIP712_DOMAIN_NAME = "BroadsideSettlement";
export const EIP712_DOMAIN_VERSION = "1";

/** Domain is bound to the dual-sig contract, not the settlement shell. */
export function domain(chainId: number | bigint, dualSigAddress: string) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: dualSigAddress,
  } as const;
}

/**
 * What gets signed. Note it carries `claimsHash`, not the claims — the array
 * is hashed separately so the signed payload is fixed-size regardless of batch
 * length, and a cosigner must recompute the hash rather than trust a
 * caller-supplied one.
 */
export const CLAIM_BATCH_TYPES = {
  ClaimBatch: [
    { name: "user", type: "address" },
    { name: "campaignId", type: "uint256" },
    // Anchors the batch to chain state (lastNonce + 1); makes a replayed or
    // reordered batch fail rather than double-pay.
    { name: "firstNonce", type: "uint256" },
    { name: "claimsHash", type: "bytes32" },
    // block.number expiry: a cosigned batch cannot be held and submitted later.
    { name: "deadlineBlock", type: "uint256" },
    // Pin the signer each side expected, so rotating a relay key invalidates
    // in-flight batches instead of letting a stale key settle them.
    { name: "expectedRelaySigner", type: "address" },
    { name: "expectedAdvertiserRelaySigner", type: "address" },
  ],
} as const;

/** view = CPM (rate is per 1000 events), click and action are flat per event. */
export enum ActionType {
  View = 0,
  Click = 1,
  RemoteAction = 2,
}

export enum CampaignStatus {
  Pending = 0,
  Active = 1,
  Completed = 2,
  Terminated = 3,
  Expired = 4,
}

export interface ClaimProof {
  /** type-1: keccak256(user, campaignId, impressionNonce) */
  clickSessionHash: string;
  /** replay guard, distinct per (viewer identity, campaign, window) */
  nullifier: string;
  /** proof-of-work solver output */
  powNonce: string;
  /** type-2: ECDSA [r, s, v-as-bytes32] */
  actionSig: [string, string, string];
}

export interface Claim {
  publisher: string;
  eventCount: bigint;
  /** clearing rate: per-1000 for view, flat for click/action */
  rateWei: bigint;
  actionType: ActionType;
  /** empty for a plain view; one entry when a proof path is in play */
  proof: ClaimProof[];
}

export interface SignedClaimBatch {
  user: string;
  campaignId: bigint;
  firstNonce: bigint;
  claims: Claim[];
  deadlineBlock: bigint;
  expectedRelaySigner: string;
  expectedAdvertiserRelaySigner: string;
  userSig: string;
  publisherSig: string;
  advertiserSig: string;
}

/**
 * Payment split, as the settlement contract computes it. Duplicated here so the
 * widget can show a viewer an accurate estimate before they sign, and so the
 * indexer can assert conservation without an RPC round trip.
 *
 * Publisher takes its snapshot rate off the top; the viewer gets 75% of what
 * remains and the protocol 25%.
 */
export const USER_SHARE_BPS = 7500n;
export const BPS = 10000n;

export function splitPayment(
  ratePlanck: bigint,
  eventCount: bigint,
  actionType: ActionType,
  snapshotTakeRateBps: bigint,
): { total: bigint; publisher: bigint; user: bigint; protocol: bigint } {
  const total =
    actionType === ActionType.View
      ? (ratePlanck * eventCount) / 1000n
      : ratePlanck * eventCount;
  const publisher = (total * snapshotTakeRateBps) / BPS;
  const remainder = total - publisher;
  const user = (remainder * USER_SHARE_BPS) / BPS;
  return { total, publisher, user, protocol: remainder - user };
}
