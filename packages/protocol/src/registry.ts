/**
 * Contract address resolution.
 *
 * Broadside registers exactly ONE name with Polkadot's `cdm` ContractRegistry.
 * That is deliberate and it is not an optimisation — the cdm registry is
 * append-only, and its own docs are explicit that "an entry cannot be deleted,
 * renamed or reassigned". Registering all ~25 contracts individually would
 * permanently pin each name to an address that can never move, which would
 * make the upgrade ladder impossible to run.
 *
 * So: `@broadside/hub` resolves to BroadsideRouter, and every other address
 * comes from the router's own `currentAddrOf(bytes32)` map, which governance
 * can re-point. This is the pattern DATUM already proved out in
 * `alpha-core/contracts/DatumGovernanceRouter.sol`, and the one all four
 * datum-labs services already follow.
 *
 * This module replaces four byte-identical copies of `registry.mjs` (relay,
 * advertiser-cosigner, indexer all carried md5 0c8b1462…).
 */

/** The only name Broadside publishes to the cdm ContractRegistry. */
export const HUB_CDM_NAME = "@broadside/hub";

/**
 * Slots registered in BroadsideRouter.
 *
 * Ported from DATUM's KNOWN_SLOTS minus what the Polkadot Products platform
 * now provides — see DROPPED_SLOTS below for where each one went.
 */
export const SLOTS = [
  // settlement spine
  "settlement",
  "dualSig",
  "claimValidator",
  "clickRegistry",
  "settlementRateLimiter",
  "nullifierRegistry",
  "powEngine",

  // campaigns
  "campaigns",
  "campaignLifecycle",
  "campaignCreative",
  "campaignAllowlist",
  "reports",

  // money
  "budgetLedger",
  "paymentVault",
  "tokenRewardVault",
  "shieldVerifier",

  // participants
  "publishers",
  "publisherStake",
  "publisherReputation",
  "publisherGovernance",
  "advertiserStake",
  "advertiserGovernance",
  "relay",
  "relayStake",
  "relayGovernance",

  // tags
  "tagSystem",
  "tagCurator",
  "tagRegistry",

  // governance + safety
  "governance",
  "parameterGovernance",
  "council",
  "blocklistCurator",
  "activationBonds",
  "challengeBonds",
  "timelock",
  "pauseRegistry",

  // token plane
  "emissionEngine",
  "mintCoordinator",
  "mintAuthority",
  "wrapper",
  "feeShare",
  "vesting",
] as const;

export type Slot = (typeof SLOTS)[number];

/**
 * Slots a live deploy MUST have. A zero address in any of these means the
 * configured hub is wrong, old, or empty — surface it rather than limping on
 * with a half-resolved registry, which is how DATUM's `registryEmpty` health
 * flag earned its keep.
 */
export const CORE_SLOTS: readonly Slot[] = ["campaigns", "settlement", "publishers"];

/**
 * DATUM slots that no longer exist, and what replaced them. Kept as data so
 * that "why isn't there an identityVerifier?" has an answer in the codebase
 * instead of in someone's memory.
 */
export const DROPPED_SLOTS: Readonly<Record<string, string>> = {
  identityVerifier: "Proof of Personhood — per-product unlinkable aliases",
  peopleChainIdentity: "Proof of Personhood — no XCM round trip needed",
  peopleChainXcmBridge: "Proof of Personhood — no XCM round trip needed",
  peopleChainBondedReporter: "Proof of Personhood — no bonded identity feed needed",
  zkVerifier: "replaced by shieldVerifier; the impression ZK circuit was dropped",
  stakeRoot: "folded into publisherStake / advertiserStake",
  stakeRootV2: "folded into publisherStake / advertiserStake",
  interestCommitments: "on-device profile only; no on-chain commitment",
  governanceV2: "renamed to governance — there is no V1 to disambiguate from",
};

/** keccak256(name) is the router's key type. Hashing is the caller's job so
 *  this package stays dependency-free; pass in whatever hasher you already have. */
export function slotKey(slot: Slot, keccak256Utf8: (s: string) => string): string {
  return keccak256Utf8(slot);
}

export function isSlot(s: string): s is Slot {
  return (SLOTS as readonly string[]).includes(s);
}
