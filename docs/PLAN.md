# Broadside — rebrand, consolidation, and migration to alpha

> The tracked plan. A phase closes when the commit that records its evidence lands — the report, the
> deployment manifest, the passing run — not when someone says it is done.

| Phase | | Status |
|---|---|---|
| 0 | PolkaVM size survey | ✅ done — [`phase0-pvm-size-report.md`](phase0-pvm-size-report.md) |
| 1 | The seam probe | 🟡 built — needs a deploy and a device run |
| 2 | Contracts: the alpha spine on PolkaVM | ⬜ not started |
| 3 | Core widget and settlement services | ⬜ not started |
| 4 | First Product publisher | ⬜ not started |
| 5 | Full contract set, token plane, governance | ⬜ not started |
| 6 | Shielded funding | ⬜ not started |
| 7 | The other surfaces | ⬜ not started |

## Context

DATUM is a working peer-to-peer ad exchange: 62 production Solidity contracts, 44 of them deployed to
Paseo Hub, an MV3 browser extension that builds and signs claims, a publisher SDK, a WordPress plugin,
and four services in `datum-labs` (relay, advertiser co-signer, indexer, shortener). It works, and it
is shaped by two assumptions that no longer hold.

**The first is EVM.** DATUM compiles to EVM bytecode for pallet-revive's compatibility mode, which
means every contract is sized against EIP-170's 24,576-byte ceiling. `DatumSettlement` is split three
ways — `Storage` + `LogicA` + `LogicB` wired by DELEGATECALL over a shared storage layout — purely to
fit. It currently sits at 24,363 of 24,576 bytes: **213 bytes of headroom**. The next feature does not
fit. Phase 0 compiled every contract with resolc 1.4.0 and found all 56 deployable ones fit under
PolkaVM's **256 KiB** blob limit — a 10.6× larger ceiling, with only `DatumGovernanceV2` (83.2%) and
`DatumCampaigns` (77.3%) tight. The split is now self-inflicted complexity.

**The second is the browser extension.** An extension is a desktop-Chrome artifact. The audience is
in the Polkadot App, where Products are sandboxed WebView bundles published to a `.dot` label — and
where an extension cannot exist at all. Meanwhile the host offers exactly the primitives the
extension was hand-rolling: deterministic entropy derivation, per-index product accounts, and a Ring
VRF anonymous alias.

Three repos also carry the same code at different vintages. `registry.mjs` exists as four
byte-identical copies across `datum-labs` services (all md5 `0c8b1462…`); the creative-format table
is duplicated between the SDK and the WordPress plugin; claim encoding exists three times
(`extension/src/background/claimCore.ts`, `datum-labs/relay/src/claims.mjs`,
`datum-tavern/src/lib/datumClaims.ts`).

**Outcome:** one repo, one core, PolkaVM contracts, and an ad interface that runs inside the Polkadot
App sandbox without ever touching the viewer's connected account.

**Who a publisher is, under this design:** anyone shipping a Polkadot App Product. A publisher adds
`@broadside/widget` to their `.dot` bundle and gets an ad slot; the viewer already has an identity,
because the host gave them one. That is the peer-to-peer part — inventory is other people's Products,
not a network of websites we have to go recruit. Plain web pages and WordPress are still served, but
they are the second and third surfaces, not the first.

## Decisions

| Decision | Choice |
|---|---|
| Old repos | `datum`, `datum-labs`, `datum-venture` stay live and untouched. No history import. |
| Continuity | Clean break. New contracts, new token, new EIP-712 domain. No state migration. |
| First surface | Polkadot App Product (`.dot`-published bundle) |
| Chain | ⚠️ **Under review.** Chosen as Paseo Asset Hub; the device run found the host carries only **Devnet Asset Hub**, so a host-routed read needs contracts there instead. Pending the 1.2.0 allowlist probe. |
| Token plane | Ships in alpha, in full |
| Personhood | Optional viewer tier — priced, not mandated |
| Repo | `Baronvonbonbon/broadside`, public, GPL-3.0-or-later |
| Viewer identity | A per-product burner derived from host entropy. The platform's own alias does not exist, and its `getUserId` is a *global* handle — see the correction below. |

## The identity architecture

This is the part that decides whether the product is possible, so it is stated before the phases.

> **Corrected 2026-08-04 by the Phase 1 device run.** This section previously claimed the platform
> provides cross-product unlinkability. It does not. See
> [`phase1-seam-report.md`](phase1-seam-report.md) gate 2.

**Broadside never sees the viewer's connected account.** Two host primitives do the work, and the
third one the plan expected does not exist:

1. **The signing key is an app-local secp256k1 burner** derived via `deriveEntropy()` under a
   Broadside domain separator. This is not an optimization — it is forced. The host signs sr25519 and
   **cannot produce an `ecrecover`-able signature**, and `AutoSigning` reports `NotAvailable` on both
   Android and iOS wallets, so every host-routed signature needs a user tap. An ad network cannot
   tap-sign per impression. Because `deriveEntropy` is deterministic — **measured, across a full app
   restart** — the burner regenerates from nothing: no seed, no backup, no export.
2. **Payout lands on a product account** (`getProductAccount(productId, index)`), which yields
   distinct keys per index — **measured**, four indices, four distinct keys.
3. ~~**Ring VRF anonymous alias**~~ — `getAnonymousAlias()` returns **null**. The primitive is not
   there.

**The unlinkability is ours, not the platform's.** `getUserId()` returns a stable, human-readable,
*global* username (`primaryUsername`), readable by any Product and identical across all of them. So a
viewer inside `ascend.dot` and the same viewer inside `tavern.dot` are trivially linkable by anyone
who asks. What holds is narrower and still sufficient: `deriveEntropy` is **product-scoped**, so
Broadside's viewer address in one Product is unrelated to its address in another. That is a real
guarantee — but it is a property of Broadside's construction, and it survives only as long as
`getUserId` never leaves the device. Treat it as key material, not as telemetry.

The consequence is honest and worth stating plainly: **anonymous earnings fragment per publisher.**
There is no cross-publisher viewer reputation and no global rate limit, which is precisely where ad
fraud lives. That is what the **optional personhood tier** buys back — a viewer who presents a
personhood credential gets one payout address, a global rate limit, and access to the premium
inventory advertisers pay more for. Anonymous viewers keep PoW + per-campaign nullifiers and accept
fragmentation.

The device run made that trade concrete rather than theoretical: `primaryUsername` is *exactly* what
a global rate limit would key on. Using it buys Sybil resistance across publishers and spends the
privacy claim to buy it. The tier boundary is therefore not a UI preference — it is the boundary
where that one call becomes permissible.

## Repo shape

Workspace globs are declared in `pnpm-workspace.yaml`.

```
broadside/
  contracts/                 Solidity → PolkaVM (resolc), hardhat
  packages/
    protocol/                ✅ exists — slots, EIP-712 claim types, IAB formats. Zero deps.
    identity/                host identity adapter: alias, burner derivation, personhood tier
    client/                  contract reads/writes over the host provider (or ethers fallback)
    widget/                  the ad slot: render, measure, claim, sign. Framework-agnostic.
  apps/
    seam/                    Phase 1 probe Product
    viewer/                  the Broadside Product: earnings, preferences, personhood
    console/                 advertiser + publisher + governance UI
  services/
    relay/                   claim intake, co-sign, gas
    cosigner/                advertiser-side key, independent of relay
    indexer/                 events → SQLite → read API
  tools/                     ✅ pvm-size-spike.mjs; + fetch-resolc.sh, build-pvm.mjs
  integrations/
    wordpress/               thin adapter over packages/widget
```

`packages/widget` is the only implementation of ad-slot behaviour. The Product, the npm package, and
the WordPress plugin are adapters over it — a rule worth enforcing in CI, because DATUM's SDK/plugin
drift is exactly what this repo exists to end.

---

## Phase 0 — PolkaVM size survey ✅

- [x] Every alpha-core contract compiled under resolc 1.4.0
- [x] [`phase0-pvm-size-report.md`](phase0-pvm-size-report.md) + `pvm-size-spike.json` committed

---

## Phase 1 — The seam probe 🟡

**The riskiest assumption, tested first.** Everything downstream assumes a Product inside the
Polkadot App WebView can derive a burner, sign EIP-712 with it, and reach a PolkaVM contract through
the host's provider. Nobody has done that. `sonde` proves the pieces separately — `host.account.eip712`
signs and recovers, `host.chain.provider` constructs a provider — but no probe closes the loop, and
sonde's published bundle carries a `PRODUCT_ID` mismatch that makes every Bank B answer a false "no"
until republished.

**Produces**
- [x] `apps/seam/` — 16 checks in dependency order, each bounded, mapping onto the five gates.
      See [`apps/seam/README.md`](../apps/seam/README.md)
- [x] `contracts/src/BroadsideSeam.sol` — EIP-712 `recover` as a **view** call, so the load-bearing
      check costs nothing and runs on an unfunded device; `attest` proves the same thing with a receipt
- [x] toolchain: `tools/fetch-toolchain.sh` (pinned + checksum-verified solc and resolc),
      `contracts/scripts/build.mjs` (both targets), `contracts/scripts/deploy.mjs`
- [x] drift guards: `sync-abi.mjs --check`, `check-identity.mjs`, 9 contract tests
- [x] `BroadsideSeam` deployed — `0xbcb6C034923130b66E7596E778d6D56c283a77B7`, chain 420420417,
      native PolkaVM (15,932 bytes), verified by `contracts/scripts/verify-seam.mjs --write`
- [x] [`phase1-seam-report.md`](phase1-seam-report.md) part 1 — the chain side
- [x] `broadside.dot` registered and published — <https://broadside.dev-dot.li>, CID
      `bafybeifqyvii2d…`, owned by `0xff54a5a1…`. See [`DEPLOY.md`](DEPLOY.md)
- [ ] part 2 of the report — the host side, from a device run **← the only thing left**

**Gate** — measured on a Pixel 10 Pro XL across two sessions, 2026-08-04:
- [x] `deriveEntropy` is deterministic *in a published bundle* — same burner
      `0xC9dbB624…` before and after a full app close
- [ ] ~~`getAnonymousAlias()` is stable per product~~ — **the call returns null; the primitive does
      not exist.** `getUserId()` returns a global username instead, which is the opposite property.
      See the identity correction above
- [x] `getProductAccount` returns distinct keys per index — 4 indices, 4 distinct keys
- [ ] The host provider reaches the chain — **no**: `Chain 0xbf0488db… is not supported by the
      current host`. An external RPC *is* reachable from inside the WebView (823 ms), so this splits
      into "can read at all" (yes) and "host-routed" (no on this build)
- [ ] A burner-signed EIP-712 payload survives on-chain `ecrecover` — contract half proven from Node,
      host half **unanswered because of a probe bug**: `contractRead` depended on the host transport
      and skipped with it, though the control path could have answered. Fixed in suite 1.1.0

Gates 1 and 2 need **two runs** with a full app restart between them: within one session a cached
value and a stable one are indistinguishable, so the first run records a baseline in the host's
per-product store and the second compares against it. The probe reports `unanswered` until then
rather than guessing.

**Risk** — highest in the plan, which is why it is first and small. **Parallel with:** Phase 2.

### Findings

**The device run landed.** Gates 1 and 3 pass; gate 2 found the primitive absent and something worse
in its place; gate 4 found the host cannot serve the chain, but an external RPC works from inside the
WebView. Gate 5 was lost to a dependency bug in the probe. Full detail and the resulting corrections
are in [`phase1-seam-report.md`](phase1-seam-report.md) part 2.

**A PolkaVM contract accepts an off-chain EIP-712 signature, and the gasless relay pattern works.**
An account with zero balance signed a `Seam`; a different account submitted `attest` and paid; the
contract recovered the signer, credited the *signer*, and recorded the submitter separately — block
11807942, 13,430 gas. That is the economic shape of the whole settlement path, working, on native
PolkaVM. Details in [`phase1-seam-report.md`](phase1-seam-report.md).

Two more came out of building it, and both are still open:

**`getHostProvider` returns polkadot-api's `JsonRpcProvider`, not ethers'.** It is a Substrate
transport over `truApi.chain.*`, so `eth_call` is not obviously something it can do. The probe asks
the transport for `rpc_methods` and reports what it actually speaks rather than assuming. If it does
not answer `eth_*`, every contract read needs a translation layer — `pine-rpc` already implements
exactly that, `eth_*` over `ReviveApi_*` — or an external endpoint, which gives up the host's
censorship story. This was already the top row of the external-unknowns table; it is now known to be
the sharp version of that question.

**The host names only two chains, and neither is Paseo Asset Hub.** `@parity/truapi` ships exactly
`PASEO_NEXT_V2_ASSET_HUB` (`0xbf0488db…`) and `PASEO_NEXT_V2_INDIVIDUALITY` (`0xc5af1826…`). DATUM and
FARE deploy to Paseo Asset Hub via `eth-rpc-testnet.polkadot.io`, chain id 420420417 — a different
chain. **If contracts are not on a chain the host carries, the widget cannot reach them through the
host at all**, which would force the external-endpoint fallback from day one. The probe imports these
constants rather than hardcoding a hash, so it measures the answer instead of assuming it. Worth
noting that the second one is the *personhood* chain, which the optional viewer tier will need.

This may change the "Chain: Paseo Asset Hub" decision. Deciding before the probe runs would be
guessing; the probe exists to make it a measurement.

---

## Phase 2 — Contracts: the alpha spine on PolkaVM ⬜

Port the minimum contract set, renamed and un-split, and deploy to Paseo. See
[Contract consolidation](#contract-consolidation) for the target list.

**Produces**
- [ ] `contracts/` — hardhat, solc 0.8.24, resolc 1.4.0 target
- [ ] `tools/build-pvm.mjs`, `tools/fetch-resolc.sh`
- [ ] `contracts/deployed-addresses.json`
- [ ] ported test suite

**Gate**
- [ ] `pnpm pvm:spike` runs against the *new* sources; every contract under 70% of the blob limit, or
      listed with a reason (today that list is `campaigns` alone, and `settlement` if the merge lands
      above the line)
- [ ] the ported test suite passes
- [ ] the eight-contract spine is deployed to Paseo and `BroadsideRouter` resolves each slot non-zero
- [ ] `@broadside/hub` is registered with the `cdm` ContractRegistry **exactly once**

**Watch:** the cdm registry is append-only — "an entry cannot be deleted, renamed or reassigned."
Registering per-contract names would permanently pin each to an address that can never move and make
the upgrade ladder impossible. One name only.

---

## Phase 3 — Core widget and the settlement services ⬜

**Produces**
- [ ] `packages/identity`, `packages/client`, `packages/widget`
- [ ] `services/relay`, `services/cosigner` — ported from `datum-labs` (`relay/src/claims.mjs`,
      `relay/src/bulletin.mjs`, `advertiser-cosigner/`) with `registry.mjs`'s four copies deleted in
      favour of `@broadside/protocol`

The claim engine ports from `datum/alpha-core/extension/src/background/` — `claimCore.ts`,
`claimBuilder.ts`, `claimQueue.ts`, `auction.ts` (Vickrey second-price), `powSolver.ts` — and the
measurement layer from `content/` (`adSlot.ts` shadow-DOM injection, `engagement.ts`
IntersectionObserver viewability + dwell, `taxonomy.ts` 26-category classifier). What does **not**
port is the extension's embedded wallet: the host replaces it.

**Gate**
- [ ] a claim built by `packages/widget`, signed by a Phase-1 burner, co-signed by relay and
      co-signer, settles on Paseo and credits the payment vault — verified by reading the vault, not
      by trusting a log line

**Depends on** Phase 1 (identity), Phase 2 (contracts).

---

## Phase 4 — First Product publisher ⬜

Dogfood. `ascend.dot` and `datum-tavern` are already Polkadot App Products with real UI surface, and
`datum-tavern` already proved four ad-integration patterns (message-board native, NPC dialogue, idle
billboard, sponsored gameplay).

**Produces**
- [ ] `apps/viewer` — earnings, preferences, personhood opt-in
- [ ] one publisher integration

**Gate**
- [ ] a real impression served to a real viewer inside the Polkadot App, on a device, claimed with a
      derived burner, settled on Paseo, and withdrawn to a product account — one hand-verified
      end-to-end run

This is the milestone the whole plan exists to reach.

---

## Phase 5 — Full contract set, token plane, governance ⬜

**Produces**
- [ ] the remaining slots of the 42 in `packages/protocol/src/registry.ts` — governance family, stake
      and bond family, tag system
- [ ] the full token plane: `emissionEngine`, `mintCoordinator`, `mintAuthority`, `wrapper`,
      `feeShare`, `vesting`
- [ ] `apps/console`, `services/indexer`

**Gate**
- [ ] every slot in `SLOTS` resolves to a deployed address
- [ ] `DROPPED_SLOTS` are all still absent — already enforced by `packages/protocol/test/protocol.test.js`
- [ ] an emission accrues and a wrap round-trips
- [ ] the indexer's conservation check balances

**Note:** the token plane's real Asset Hub XCM unwrap is the one part DATUM's own launch plan marked
*deferred*. Alpha ships the testnet variant; mainnet XCM is a separate gate.

---

## Phase 6 — Shielded funding ⬜

The remaining privacy gap, and it is a real one: a viewer's earnings account is unlinkable *within*
the sandbox, but the moment they move funds to a real wallet, the transaction re-links them. FARE hit
this exact wall and solved it — deposit into **Kusama Shield** (Paseo pool
`0x7d5a496bD61b631025A828d9049f6A68e007e0dC`), then relay-mediated `proxy_withdraw` pays the burner
with no `main→burner` edge. Proven live for native PAS and real USDC.

**Produces**
- [ ] `packages/shield` — ported from `fare/web/src/shieldpool.ts` + `shield.ts`
- [ ] `services/relay` shield endpoints
- [ ] the `shieldVerifier` slot wired

**Gate**
- [ ] a viewer withdraws earnings to a fresh address with no on-chain edge to their main account,
      verified by a leak-sweep run over every tx in the flow

**Deliberately late.** It depends on someone else's deployed pool with five documented integration
bugs (`fare/docs/KUSAMA-SHIELD-FINDINGS.md`). Interim posture: viewers withdraw to a product account
and are told plainly, in the UI, that consolidating to a main wallet links them.

---

## Phase 7 — The other surfaces ⬜

**Produces**
- [ ] `packages/widget` published as `@broadside/widget` for plain web pages
- [ ] `integrations/wordpress/` — ported from `datum/wordpress-plugin/datum-publisher/` (Gutenberg
      block, shortcode, sidebar widget, admin panel) as an adapter, with the bundled-SDK-copy pattern
      replaced by a build-time dependency

**Gate**
- [ ] the same creative renders and the same claim settles from a plain web page and from a WordPress
      post, with no code path forked from the Product build
- [ ] CI fails if `integrations/wordpress` contains a copy of anything in `packages/`

---

## Contract consolidation

Phase 0 measured **56 deployable** contracts (plus 7 abstract/library units). The target is the 42
slots in `registry.ts` plus the router — the 9 dropped slots and the `Migration`/`Storage` carve-outs
account for the difference.

### Collapse — EIP-170 artifacts with no reason to exist under PolkaVM

`BroadsideSettlement` ← `DatumSettlement` + `DatumSettlementLogicA` + `DatumSettlementLogicB` +
`DatumSettlementStorage`. The three-way DELEGATECALL split exists only to fit 24,576 bytes; `LogicA`
is 98 lines of pure dispatch that disappears entirely on merge.

**Do not size this by summing the three measurements.** Each was compiled independently and each
carries the full inherited base (`DatumSettlementStorage`, `DatumUpgradable`, `DatumOwnable`,
`DatumPlumbingLockable`), so the sum — 243,797 B, 93% of the limit — triple-counts it and would
wrongly suggest the merge is unsafe. Method that isolates the base: `DatumInterestCommitments` is 34
lines and 3,833 B, so PolkaVM's *fixed* runtime overhead is ~4 KB; `LogicA` is 98 lines and 37,642 B,
so its inherited base is **~34 KB**. Counting that base once:

```
  base, once                      ~34 KB
+ Settlement's own code      77 − 34 = ~43 KB
+ LogicB's own code         129 − 34 = ~95 KB
− dispatch plumbing removed            ~5 KB
                                  ─────────
                                  ~167 KB   ≈ 65% of 256 KiB
```

**Error bar ±20 KB** (57–73%) — the base figure is inferred, not measured, and viaIR can inline
either way across a merged contract. That straddles the 70% "comfortable" line, so this is a
*measurement*, not an assumption: run `pnpm pvm:spike` the day the merge lands. **If it exceeds 70%,
keep the split** — it already works.

`DatumCampaignsMigrationLogic` is a second EIP-170 carve-out, but a clean-break deploy has nothing to
migrate. **Do not port it in alpha.** It comes back with the first real contract upgrade, at which
point it is a new decision with real numbers.

### Splits that must survive

Regardless of the ceiling — each is a distinct upgrade path or trust boundary, not a size workaround:
the governance family (`governance`, `parameterGovernance`, `council`, `blocklistCurator`, and the
three role-scoped governances), the stake family (`publisherStake`, `advertiserStake`, `relayStake` —
separate curves, separate slash pools), the token pipeline (`emissionEngine`, `mintCoordinator`,
`mintAuthority`, `wrapper`, `feeShare`, `vesting`), and the guards consulted per settlement
(`claimValidator`, `clickRegistry`, `nullifierRegistry`, `settlementRateLimiter`, `powEngine`,
`pauseRegistry`, `publisherReputation`).

### Replacing `test/settlement-layout.test.ts`

That test guards a shared DELEGATECALL storage layout that will no longer exist, and
`validateSettlementLayoutMatchesSnapshot()` goes with it. Two things replace it: a storage-layout
snapshot of `BroadsideSettlement` itself, diffed in CI so a field reorder fails review; and a
`_migrate` state-copy assertion that every field read off the old instance matches the new one's
post-migration value. Carry `outputSelection: { "*": { "*": ["storageLayout"] } }` across from
`datum/alpha-core/hardhat.config.ts` — the snapshot needs it. The upgrade ladder itself is unchanged:
`BroadsideRouter` re-points, exactly as `DatumGovernanceRouter` does.

### The Phase 2 minimum set — `CORE_SLOTS` is not enough

`registry.ts` names `campaigns`, `settlement`, `publishers` as the slots that must be non-zero, and
that is the right health check, but it does not describe a system that can pay anyone. Settlement
debits `budgetLedger` and credits `paymentVault`; without both, a claim validates and then goes
nowhere. The real minimum for a settling, paying deploy is **eight**:

| # | Contract | ← DATUM source | PVM bytes | % |
|---|---|---|---:|---:|
| 1 | `BroadsideRouter` | `DatumGovernanceRouter` | 90,371 | 34.5% |
| 2 | `BroadsideSettlement` | Settlement + LogicA + LogicB + Storage | ~167,000 est. | ~65% |
| 3 | `BroadsideCampaigns` | `DatumCampaigns` | 202,662 | 77.3% |
| 4 | `BroadsidePublishers` | `DatumPublishers` | 115,403 | 44.0% |
| 5 | `BroadsideBudgetLedger` | `DatumBudgetLedger` | 108,771 | 41.5% |
| 6 | `BroadsidePaymentVault` | `DatumPaymentVault` | 106,503 | 40.6% |
| 7 | `BroadsideDualSig` | `DatumDualSigSettlement` | 85,670 | 32.7% |
| 8 | `BroadsideClaimValidator` | `DatumClaimValidator` | 93,512 | 35.7% |

7 and 8 are not optional despite being outside `CORE_SLOTS`: the three-signature envelope in
`packages/protocol/src/claims.ts` *is* the fraud model, including the guard that rejects a batch whose
publisher and advertiser signatures recover to the same key (DATUM's `E89`) — the check that makes
the adverse-interest argument load-bearing rather than decorative. `pauseRegistry` is cheap insurance
and should land with them. The other 34 slots resolve to zero and are skipped.

`BroadsideCampaigns` at **77.3%** is the one contract with no headroom. It has no split to collapse,
so it needs a deliberate decision in Phase 2 — trim, or split it on a real architectural seam
(lifecycle/creative/allowlist are already separate contracts; more can follow) rather than an
accidental one.

### Renames that are more than mechanical

Everywhere else is search-and-replace.

| Rename | Why it is load-bearing |
|---|---|
| EIP-712 domain `DatumSettlement` → `BroadsideSettlement` | Deliberate break. A signature ever valid against DATUM must not be valid here. Already pinned in `packages/protocol/src/claims.ts`. |
| `DatumGovernanceV2` → `BroadsideGovernance` | The `V2` is in the domain separator and in off-chain indices that key on the name. There is no V1 to disambiguate from — `registry.ts` already records the rename. |
| `zkVerifier` → `shieldVerifier` | Not a rename: a different contract with a different job. Nothing ports; it is written fresh in Phase 6. The old slot is in `DROPPED_SLOTS` and the protocol test fails if it returns. |
| Error codes `E00`/`E11`/`E18`/`E89`… | Clients parse these. They are not brand strings — carry them across unchanged, and do not renumber. |
| `WDATUM` symbol, `"Wrapped DATUM"` name | ABI-facing and permanent once deployed. See Open decisions. |

## What gets deleted rather than ported

Worth naming, because not porting is the main way this repo stays smaller than DATUM.

| Dropped | Why | Replaced by |
|---|---|---|
| `extension/` (MV3, ~255 brand refs) | Cannot exist in the Polkadot App | `packages/widget` + host identity |
| Extension embedded wallet (AES-GCM + PBKDF2) | The host holds keys | `deriveEntropy` burner |
| `identityVerifier`, `peopleChainIdentity`, `peopleChainXcmBridge`, `peopleChainBondedReporter` | XCM round-trip to People Chain | Proof of Personhood, per-product aliases |
| `zkVerifier` + `circuits/impression.circom` | The impression ZK circuit is dropped | `shieldVerifier` (Phase 6) |
| `stakeRoot`, `stakeRootV2` (56 KB of fraud-proof machinery) | Merkle stake roots with N-of-M reporters | folded into `publisherStake` / `advertiserStake` |
| `interestCommitments` | On-device profile only | no on-chain commitment |
| 4× `registry.mjs` (md5 `0c8b1462…`) | Copy drift | `@broadside/protocol` |
| `sdk/datum-sdk.js` (42 KB UMD) + its 4 CI-synced copies | Copy drift | `packages/widget` |

## Critical files

**Read before starting:** `packages/protocol/src/registry.ts` (the slot list and every dropped slot
with its reason), `packages/protocol/src/claims.ts` (the EIP-712 struct and the payment split),
[`phase0-pvm-size-report.md`](phase0-pvm-size-report.md) (the size budget), `sonde`'s `README.md` +
`DEPLOY.md` (the host runtime and its publishing rules), FARE's `docs/PRIVACY.md` (the privacy model
this inherits).

**Port from:** `datum/alpha-core/contracts/` · `datum/alpha-core/extension/src/background/` and
`src/content/` · `datum-labs/relay/` and `advertiser-cosigner/` and `indexer/` ·
`datum/wordpress-plugin/datum-publisher/` · `fare/scripts/build-pvm.mjs` ·
`fare/web/src/shieldpool.ts` · `fare/test/leak-sweep.test.ts` · `datum-labs/deploy/docker/`.

## Verification

- **Size gate** — `pnpm pvm:spike` on every contract change; `pvm-size-spike.json` is committed and
  diffed, so a contract crossing 70% of the blob limit shows up in review.
- **Protocol invariants** — `packages/protocol/test/protocol.test.js` already pins format-tag/id
  agreement, slot uniqueness, dropped-slot absence, and exact conservation of the payment split
  across truncating integer division. Keep it dependency-free.
- **Contracts** — port DATUM's hardhat suite (104 files, ~2,080 cases), including
  `access-control.test.ts` (530 denial checks) and `upgrade-e2e.test.ts`.
- **Privacy** — port FARE's `leak-sweep.test.ts`: a secrets table checked against every tx's calldata,
  log data, and log topics, in minimal-width, padded, and two's-complement encodings, with a planted
  positive control so the matcher itself is tested.
- **Gas** — port FARE's gas snapshot with its ±5% CI gate.
- **Drift** — CI fails if any file in `integrations/` or `apps/` duplicates a `packages/` module.
- **End to end** — the Phase 4 gate, run on a real device, is the only test that proves the product.

## External unknowns

| Unknown | Blocks | Fallback if unfavourable |
|---|---|---|
| ~~Is `getAnonymousAlias()` stable per product?~~ | — | **Answered: it returns null.** The fallback is now the design — the per-product derived burner *is* the pseudonym. Same unlinkability, but Broadside's convention rather than a platform guarantee. |
| ~~Does `getUserId()` exist and return something stable?~~ | — | **Answered: yes, and it is a global username.** Not a capability to build on — a hazard to quarantine. It is also the only thing a global rate limit could key on, which is the anonymous/verified tier boundary. |
| ~~Can the host provider reach pallet-revive?~~ | — | **Answered: not for `paseo-asset-hub` on this build.** An external `eth-rpc` endpoint *is* reachable from inside the WebView. `pine-rpc` remains the option that keeps verification without the host. |
| ~~Which chains does this host build carry?~~ | — | **Answered: `devnet-asset-hub`, and nothing else.** One of eight. So `BroadsideSeam` on Paseo Asset Hub is unreachable through the host by construction. |
| **Is a runtime-call method on the host's RPC allowlist?** | Phase 2 deploy target, Phase 3 client | The host blocks `eth_*` and `rpc_methods`, so the surface can only be probed. Suite 1.2.0 tries `state_call` / `archive_v1_call` / `chainHead_v1_call`. **Yes** → deploy to Devnet Asset Hub and read through the host via SCALE-encoded `ReviveApi_call`. **No** → no host-routed read exists at all, and the widget uses an external endpoint or `pine-rpc`, giving up the censorship story. |
| Does `cdm` accept EVM bytecode, or is PolkaVM mandatory? | Phase 2 | Either way Broadside targets PolkaVM, so this only affects whether an EVM escape hatch exists. |
| Bulletin retention is ~2 weeks | Phase 4 onward | The `.dot` bundle needs a renewal keeper. FARE reached the same conclusion (`POLKADOT-PLATFORM-PLAN.md` §4.6). |
| Kusama Shield pool availability and its 5 known bugs | Phase 6 | Phase 6 is already last, and the interim posture is a plain UI warning. |
| Personhood credential API surface | Phase 5 | Ship the anonymous tier alone; the verified tier is additive by design. |

## Open decisions

- **Token name and symbol.** DATUM/WDATUM has no obvious Broadside analogue and the symbol is
  ABI-facing, so it wants deciding before Phase 5 rather than during it.
- ~~**`.dot` label for the viewer Product.**~~ **Settled** — `broadside.dot` is registered and owned
  by `0xff54a5a1…`. Two assumptions it contradicted are recorded in [`DEPLOY.md`](DEPLOY.md): a
  9-character label was not personhood-gated, and `pad` pays for registration from a funded local
  worker rather than the signed-in account, so the signer's balance is not the budget. The warning
  still stands for any *further* names: `pad` has no read-only availability check and registers any
  name the signer is eligible for.
