// The published identity, and the one invariant that governs it.
//
// PRODUCT_ID must equal the DotNS label. The host derives product accounts and
// the local-storage namespace from it, and allowances are looked up per
// product. If the two drift apart, every host call exercises an identity that
// never published anything and returns a confident "no" — not an error, which
// is what makes it dangerous. sonde shipped exactly that bug on its first
// publish, so `npm run check-identity` in that repo exists to prevent it; the
// same check runs here before deploy.
//
// This label is not registered yet. Registering costs 11 PAS, is permanent, and
// `pad` has no read-only availability query — it registers any name the signer
// is eligible for, which cost sonde 33 PAS in three accidental names. Check
// with sonde/tools/whoowns.sh before pointing `pad` at anything.

export const PRODUCT_ID = "broadsideseam";
export const DOT_NAME = `${PRODUCT_ID}.dot`;

// Must equal the --env passed to `pad`. The SDK defaults cloud storage to
// "paseo"; publishing under devnet and leaving that defaulted asks the host for
// a chain a devnet build does not carry, and createApp throws.
export const CLOUD_ENV = "devnet";

export const SUITE_VERSION = "1.0.0";

export const SOURCE_URL = "https://github.com/Baronvonbonbon/broadside";

// Domain separators for the derived key.
//
// Two of them, and the split is deliberate: the entropy label is what the host
// hashes, and the key domain is what turns that entropy into a signing key. A
// future Broadside product asking the host for the same entropy label would get
// the same bytes, so the key domain is what keeps the seam probe's key distinct
// from anything the real widget will derive.
export const ENTROPY_LABEL = "broadside/v1/seam";
export const KEY_DOMAIN = "broadside/v1/seam/claim-key";

// A second label, used only to prove that different inputs give different
// entropy. A deriveEntropy that ignored its argument would otherwise look
// perfectly deterministic.
export const ENTROPY_LABEL_ALT = "broadside/v1/seam/control";

// Where a state-changing write goes, if anyone runs one.
//
// Empty until BroadsideSeam is deployed — `contracts/deployed-addresses.json`
// is the source, copied here at build time rather than imported, because this
// bundle is published standalone and cannot reach the repo.
export const SEAM_ADDRESS = "";

// An Ethereum-RPC endpoint for the control path. The host transport is the
// thing under test; this is what it gets compared against, and a difference
// between them is the finding. Empty disables the control path rather than
// silently testing nothing.
export const ETH_RPC_URL = "";
