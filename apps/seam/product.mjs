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

// `broadside`, not `broadsideseam`: the probe is a throwaway but the name is
// permanent, and the contenthash behind it is not — so the flagship label gets
// registered once and re-pointed at the real product later. It also means the
// baseline this probe records sits under the same product identity the widget
// will use, which is what makes its answers transferable rather than a
// measurement of some other product's behaviour.
export const PRODUCT_ID = "broadside";
export const DOT_NAME = `${PRODUCT_ID}.dot`;

// Must equal the --env passed to `pad`. The SDK defaults cloud storage to
// "paseo"; publishing under devnet and leaving that defaulted asks the host for
// a chain a devnet build does not carry, and createApp throws.
export const CLOUD_ENV = "devnet";

// 1.6.0 — breadcrumbs carried into timeout findings so a stall names the await
// that never returned; the report downloads mid-run instead of only at the end.
// 1.5.0 — the alias comparison no longer pits a hex string against raw bytes;
// the control RPC is raw fetch with a real AbortController, not ethers.
// 1.4.0 — asks for the Ring VRF alias on AccountsProvider.getProductAccountAlias,
// the supported surface, instead of the deprecated app.wallet.getAnonymousAlias.
// 1.3.0 — a timeout is no longer reported as "reached the node"; per-attempt
// timing on the contract read; the in-flight row counts elapsed against budget.
// 1.2.0 — names the in-flight check so a stall can be attributed; probes the
// host's RPC allowlist for a runtime-call method, since rpc_methods is blocked.
// 1.1.0 — sweeps the chains the host actually carries instead of assuming
// truapi's two; stops gate 5 inheriting the host transport's failure; reports
// getUserId as a privacy hazard rather than a capability.
export const SUITE_VERSION = "1.6.0";

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

// The deployed BroadsideSeam. Kept here as documentation; the value the app
// actually uses comes from `src/generated/seam.json`, which is generated from
// `contracts/deployed-addresses.json` and checked for staleness before publish.
export const SEAM_ADDRESS = "0xbcb6C034923130b66E7596E778d6D56c283a77B7";

// An Ethereum-RPC endpoint for the control path. The host transport is the
// thing under test; this is what it gets compared against, and a difference
// between them is the finding. Empty disables the control path rather than
// silently testing nothing.
//
// Note this endpoint serves chain id 420420417 — the Paseo Asset Hub that DATUM
// and FARE deploy to. `@parity/truapi` names a *different* chain, Paseo Next v2
// Hub. Whether the host can reach this one is exactly what `chain.hostTransport`
// is for; if it cannot, this control path is the fallback, and the report will
// show one working while the other does not.
export const ETH_RPC_URL = "https://eth-rpc-testnet.polkadot.io/";
