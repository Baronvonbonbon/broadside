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

### Gate 4 — the host does not carry the chain

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
