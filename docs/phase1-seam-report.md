# Phase 1 — seam report, part 1: the chain side

**Date:** 2026-08-04 · **Contract:** `0xbcb6C034923130b66E7596E778d6D56c283a77B7` ·
**Chain:** 420420417 via `https://eth-rpc-testnet.polkadot.io/` ·
**Reproduce:** `node contracts/scripts/verify-seam.mjs --write`

Phase 1 asks five questions. Three of them are about the Polkadot App and need a device; this
report covers the two that do not, because they could have been false for reasons that have nothing
to do with the host — the compiler, the precompile, or the chain — and finding that out first is
cheap.

## What was established

`BroadsideSeam` was compiled with resolc 1.4.0 to a **native PolkaVM blob** and deployed to Paseo
Asset Hub. Not EVM-compatibility mode: 15,932 bytes of PolkaVM, confirmed byte-for-byte against
`eth_getCode`.

| | Check | Evidence |
|---|---|---|
| ✓ | Code is deployed | 15,932 bytes on chain, matching the artifact exactly |
| ✓ | Contract agrees on chainId | reports 420420417, same as the RPC |
| ✓ | Domain separator matches | client-computed hash equals the contract's |
| ✓ | Digest matches | `hashSeam` equals ethers' `TypedDataEncoder.hash` |
| ✓ | **`ecrecover` returns the signer** | a PolkaVM contract recovered the off-chain EIP-712 signer |
| ✓ | High-`s` twin is rejected | the malleability guard fires, so one signature stays one authorisation |
| ✓ | **The gasless relay pattern works** | signed by an account holding no funds; submitted and paid for by another; credited to the signer |

The last row is the one that matters most, and it is worth being precise about what it shows. A
freshly generated account with **zero balance** signed a `Seam`. A different account submitted
`attest` and paid the gas. The contract recovered the signer, stored the attestation under the
*signer*, and recorded the submitter separately. Block 11807942, **13,430 gas**.

That is the whole economic shape of the settlement path in miniature: the viewer signs and never
holds funds, the relay pays, and the contract credits the viewer rather than whoever posted the
transaction.

## What this does not establish

**The host half of gate 5 is still open.** This proves a PolkaVM contract accepts an off-chain
secp256k1 EIP-712 signature. It does not prove the Polkadot App can *produce* such a key — that is
`deriveEntropy` — or that a Product can reach this contract from inside the WebView. Only
`apps/seam` on a device answers those.

**Gates 1, 2 and 3 are untouched.** Determinism, alias stability and per-index account derivation
are host questions, and two of them need two runs with an app restart in between.

**Gate 4 has a known complication.** This contract is on chain id 420420417, which is where DATUM
and FARE deploy. `@parity/truapi` names a different chain — `PASEO_NEXT_V2_ASSET_HUB`, genesis
`0xbf0488db…`. Whether the host can reach 420420417 at all is unresolved: both Paseo Asset Hub
Substrate RPC endpoints tried from here returned nothing, and the eth-rpc endpoint does not serve
block 0, so the two could not be compared off-device. The probe carries both — it asks the host
transport what it speaks, and uses the eth-rpc endpoint as a control — so the on-device run answers
it by measurement rather than by argument.

If the host cannot reach 420420417, the contracts move to the chain the host carries. That is a
cheap change now and an expensive one after Phase 2.

## Notes

**The deployer is not Alice.** `datum/alpha-core/.env` and `fare/.env` share one
`DEPLOYER_PRIVATE_KEY`, `0x26194fE2e00A837b2a3f4e92A09E835AbB3DCEE3`, holding 9,729 PAS. It is a
real personal key, not the well-known `//Alice` dev account, so it should not be treated as
disposable — anything deployed with it is controlled by whoever holds that file.

**`recover` is a `view` function on purpose.** The load-bearing check costs nothing and works on a
device with no funds, which is the only way a probe handed to a stranger can answer gate 5 at all.
`attest` exists to prove the same claim a second way, through a receipt.
