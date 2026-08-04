# Phase 1 — seam report

**Contract:** `0xbcb6C034923130b66E7596E778d6D56c283a77B7` (native PolkaVM, 15,932 bytes) on chain
420420417 · **Product:** `broadside.dot` · **Device:** Pixel 10 Pro XL, Android 16, Chrome 150 WebView

Two parts, because two things were measured separately: the chain, from Node; and the host, from the
Polkadot App on a real phone across two sessions.

---

## Part 1 — the chain side

Reproduce: `node contracts/scripts/verify-seam.mjs --write`

`BroadsideSeam` was compiled with resolc 1.4.0 to a **native PolkaVM blob** — not EVM-compatibility
mode — and deployed to Paseo Asset Hub.

| | Check | Evidence |
|---|---|---|
| ✓ | Code is deployed | 15,932 bytes on chain, matching the artifact exactly |
| ✓ | Contract agrees on chainId | reports 420420417, same as the RPC |
| ✓ | Domain separator matches | client-computed hash equals the contract's |
| ✓ | Digest matches | `hashSeam` equals ethers' `TypedDataEncoder.hash` |
| ✓ | **`ecrecover` returns the signer** | a PolkaVM contract recovered the off-chain EIP-712 signer |
| ✓ | High-`s` twin is rejected | the malleability guard fires |
| ✓ | **The gasless relay pattern works** | zero-balance signer, different payer, credited to the signer |

The last row is the shape of the whole settlement path: an account holding **zero balance** signed a
`Seam`, a different account submitted `attest` and paid, and the contract credited the *signer* while
recording the submitter separately. Block 11807942, **13,430 gas**.

---

## Part 2 — the host side

Two runs on a real device, with a full app close between them. Suite 1.0.0, build
`2026-08-04T14:28:08.278Z`.

| Gate | Verdict |
|---|---|
| 1 · `deriveEntropy` is deterministic in a published bundle | **pass** |
| 2 · `getAnonymousAlias` is stable per product | **fail — the call does not exist** |
| 3 · `getProductAccount` yields distinct keys per index | **pass** |
| 4 · the host provider reaches the chain | **fail** |
| 5 · a burner signature survives on-chain `ecrecover` | unanswered — *probe bug, see below* |

### Gate 1 — the no-backup key design holds

The burner derived to `0xC9dbB6248247a5e6Ec55893bD47a247E14E6E199` in run 1, and to the same address
in run 2 after the app was fully closed and reopened. Entropy fingerprint identical
(`0x6ff9f61d…`). Different labels produced different entropy, so the domain separator is honoured
rather than ignored.

This is the load-bearing one. The key is regenerated from the host on demand — no seed, no backup,
no export, nothing for a viewer to lose. It survives a restart, which is the claim a single session
could not have distinguished from a cache.

### Gate 2 — there is no Ring VRF alias, and something worse is there instead

`getAnonymousAlias()` returned **null**. The primitive the plan named as the viewer's pseudonym does
not exist in this runtime.

That alone would just mean deriving a pseudonym ourselves. The complication is what `getUserId()`
returns:

```json
{ "primaryUsername": "baronvonbonbon.01" }
```

A stable, human-readable, **global** username — readable by any Product, identical across all of
them. So the platform does not provide cross-product unlinkability at all. It provides the exact
opposite, by default, to anyone who asks.

**This inverts an assumption in the plan.** `docs/PLAN.md` said a viewer inside `ascend.dot` and the
same viewer inside `tavern.dot` are unlinkable *by the platform's design*. They are not. They are
unlinkable only if every Product declines to call `getUserId`, which is not a property of the
platform but a promise made by each publisher's code.

What survives is that Broadside's own identity is sound: the burner is derived from **product-scoped
entropy**, so Broadside's viewer address in one Product is unrelated to its address in another. The
unlinkability is real but it is *ours*, not inherited — and it holds only as long as `getUserId`
never leaves the device.

There is a genuine trade underneath, and it is now explicit rather than theoretical: that username is
exactly what a **global rate limit** would key on. Using it buys real Sybil resistance across
publishers and spends the privacy claim to buy it. That is the anonymous-vs-verified tier decision,
arriving earlier and sharper than expected.

### Gate 3 — per-index accounts work

Indices 0, 1, 2 and 7 produced four distinct public keys. Per-session payout addresses are derivable.

### Gate 4 — answered in run 3: the host carries exactly one chain, and it is not ours

Suite 1.1.0 swept all eight descriptors with `isChainSupported`:

| supported | unsupported |
|---|---|
| `devnet-asset-hub` | the other seven — including `devnet-bulletin`, `devnet-individuality`, and every Paseo, Kusama and Polkadot chain |

**One of eight.** The transport then opened cleanly against it and round-tripped in 425 ms, with
`chainSpec_v1_genesisHash` returning `0xd6eec261…` — exactly the descriptor's value, so the chain is
genuinely there and correctly identified.

Two things follow, and both are decisions rather than observations:

**`BroadsideSeam` is on the wrong chain for a host-routed path.** It is deployed to Paseo Asset Hub
(420420417). The host does not carry Paseo Asset Hub. A Product on this build cannot reach that
contract through the host at any price — the fix is deploying to Devnet Asset Hub, not tuning
anything.

**The host transport does not speak Ethereum RPC.**

```
eth_chainId → Method "eth_chainId" is not supported by the host
rpc_methods → 0 methods
```

`rpc_methods` returning nothing while `chainSpec_v1_genesisHash` works means the host runs an
**allowlist** and `rpc_methods` is not on it — so the surface cannot be enumerated, only probed. Suite
1.2.0 therefore tries a candidate list one method at a time and classifies each answer: a refusal
phrased as *"not supported by the host"* is the host blocking it, and anything else — including an
invalid-params error — proves the method reached the node. That is the distinction that matters, and
it is the only way left to find out whether `state_call` / `archive_v1_call` / `chainHead_v1_call`
are available, which is what a `ReviveApi_call` contract read needs.

**Meanwhile there is a working path today.** The control check reached
`https://eth-rpc-testnet.polkadot.io/` from inside the WebView in 788 ms. The embedder does not block
outbound HTTP. So a Product can read pallet-revive right now — just not through the host, and so
without inheriting the host's censorship-resistance.

One inconsistency worth flagging rather than smoothing over: `createApp({environment:"devnet"})`
succeeds and reports `cloudStorage: true`, yet `isChainSupported(devnet-bulletin)` says **no**. Cloud
storage evidently does not go through the same capability check it reports on. Do not treat
`isChainSupported` as authoritative for anything other than the chain-provider path.

### Gate 4, as first observed in run 2 — the host does not carry the chain

```
Chain 0xbf0488db… is not supported by the current host.
```

`0xbf0488db…` is `PASEO_NEXT_V2_ASSET_HUB`, the only Asset Hub `@parity/truapi` names — and the probe
asked for it because that was the only name available. **That was the wrong question.**
`@parity/product-sdk-descriptors` ships **eight** chains, and a host build carries a subset:

| descriptor | genesis |
|---|---|
| `devnet-asset-hub` | `0xd6eec261…` |
| `devnet-bulletin` | `0x919b0847…` |
| `devnet-individuality` | `0xd66fa089…` |
| `paseo-asset-hub` | `0xbf0488db…` |
| `paseo-bulletin` | `0x8cfe6717…` |
| `paseo-individuality` | `0xc5af1826…` |
| `kusama-asset-hub` | `0x48239ef6…` |
| `polkadot-asset-hub` | `0x68d56f15…` |

`createApp({environment:"devnet"})` succeeded with cloud storage available, so this host is a
**devnet build** and carries devnet-bulletin at least. The probable answer is that it carries
`devnet-asset-hub` and not `paseo-asset-hub` — but "probable" is not a measurement, so 1.1.0 sweeps
all eight with `isChainSupported` and asks.

**Meanwhile there is a working path.** The control check reached
`https://eth-rpc-testnet.polkadot.io/` from inside the WebView in 823–1641 ms and read chain id
420420417 correctly. The embedder does not block outbound HTTP to an external RPC. So a Product can
reach pallet-revive today; it just cannot do so *through the host*, which is what the host-routed
gate was really asking.

That is why gate 4 is now two gates: **can a Product read the contract at all** (yes, via an external
endpoint) versus **can it do so with no external endpoint** (not on this build, for this chain).
Those have different answers and conflating them hid a shippable path behind a failure.

### Run 4 — the host allows the modern JSON-RPC spec and blocks the legacy one

| allowed | blocked |
|---|---|
| `chainSpec_v1_genesisHash`, `chainSpec_v1_chainName`, `chainSpec_v1_properties`, `transaction_v1_broadcast` | `state_call`, `state_getRuntimeVersion`, `state_getMetadata`, `archive_v1_call`, `system_chain`, `system_health`, `system_properties`, `author_submitExtrinsic` |
| **not refused, but did not answer:** `chainHead_v1_call`, `chainHead_v1_storage` | |

That is a coherent policy rather than an arbitrary list: the host exposes the **new JSON-RPC spec**
(`chainSpec_v1_*`, `chainHead_v1_*`, `transaction_v1_*`) and blocks the **legacy** surface
(`state_*`, `system_*`, `author_*`) entirely. `archive_v1_call` is blocked too, so there is no
archive path either.

**`chainHead_v1_call` is the only door to a runtime call, and it is not locked.** It did not answer
this probe because the probe asked wrongly: `chainHead_v1_*` is subscription-based — a call must
carry a `followSubscription` from `chainHead_v1_follow`, and its *result* arrives as a notification
rather than as a reply to the request id. The probe's transport correlates by id only, so it cannot
see one. That is a client-shape problem, not a permission one, and it is exactly the lifecycle PAPI
implements and `pine-rpc` drives contract reads through
(`src/transport/ChainManager.ts` → `runOperation("chainHead_v1_call", (subId) => …)`).

`transaction_v1_broadcast` being allowed while `author_submitExtrinsic` is blocked completes the
picture: the write path exists, on the new spec.

**So Phase 3's client is PAPI, not raw JSON-RPC.** `app.chain.connect(devnet-asset-hub)` plus
`@parity/product-sdk-contracts`, which is what `ChainApi.getRawClient` documents itself as being for.
A hand-rolled JSON-RPC client cannot drive this surface no matter how many methods it is allowed.

**A correction to run 4's own evidence.** Suite 1.2.0 classified methods into allowed and blocked,
and folded a timeout into "reached the node" — so it reported `chainHead_v1_call` as *available* on
the strength of it never answering. That is a false positive of exactly the kind this probe exists to
avoid. 1.3.0 separates a third bucket, `noAnswer`, and says plainly that an absent answer is not
evidence of anything.

### Run 3 also stalled, and the UI could not say where

The run reached `Running… 14/17` and stopped visibly progressing. That count reports *completed*
checks, and nothing on screen named the one in flight — so the single most useful fact about a stall
was the one thing the interface could not show. Every check is bounded, so it would have moved on;
the defect is that a bounded stall and a hang are indistinguishable to the person watching.

1.2.0 renders a row for each check *before* running it, replaced by the result when it settles, and
the runner now diagnoses a blown budget as `never-settled` rather than folding it in with call
failures. Budgets on the network checks came down too — 45 s to 25 s for the contract reads, 120 s to
20 s for the write, with the transports capped at 12 s inside them — so an unresponsive endpoint
resolves in a fifth of the time it used to.

### Gate 5 — unanswered because of a bug in this probe

`chain.contractRead` declared `needs: ["chain.hostTransport"]`, so when the host transport failed the
read skipped — and `seam.recoverOnChain` skipped behind it — **even though the control path was up
and could have answered it.** A check that can succeed by another route should not inherit the
failure of a route it did not need. Fixed in 1.1.0: `contractRead` depends on nothing and uses
whichever transport works.

The local half did pass. The burner signed an EIP-712 payload bound to chain 420420417 and
`0xbcb6C034…`, and recovered to itself. Combined with part 1 — where a PolkaVM contract recovered an
off-chain signature of exactly this shape — the remaining risk is small. But it is not zero and it is
not measured, so gate 5 stays open until a device run closes it.

---

## What changed as a result

1. **Probe 1.1.0** sweeps the eight known chains, breaks the false dependency that cost gate 5, and
   reports `getUserId` as a hazard rather than a capability.
2. **The identity architecture in `docs/PLAN.md` needs a correction.** Unlinkability is Broadside's
   own construction, not a platform guarantee, and the plan currently claims the latter.
3. **Where contracts live is now a real decision.** If the host carries only `devnet-asset-hub`, then
   host-routed reads require deploying there, and `BroadsideSeam` on 420420417 is on the wrong chain
   for that path. The alternative is accepting an external RPC and losing the censorship story. The
   sweep decides it.

## Notes

**The deployer is not `//Alice`.** `datum/alpha-core/.env` and `fare/.env` share one real personal
key, `0x26194fE2…`. Anything deployed with it is controlled by whoever holds that file.

**The username is deliberately not recorded in the report JSON.** Publishing a reporter's global
handle next to their burner address would hand any reader the exact correlation the design exists to
prevent — in a document arguing the correlation is hard. 1.1.0 records only its shape.
