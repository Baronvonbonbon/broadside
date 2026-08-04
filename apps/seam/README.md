# seam — the Phase 1 probe

Everything Broadside plans to build assumes one thing nobody has demonstrated:

> A Product running inside the Polkadot App can derive a signing key from the
> host, sign an EIP-712 payload with it, and have a PolkaVM contract's
> `ecrecover` accept that signature — with no user tap and no gas.

If that is false the architecture changes, so it is tested first, before any
contract is ported. This is the smallest thing that can prove or disprove it.

## Why it has to be a key the app holds

The host signs **sr25519** and cannot produce an `ecrecover`-able signature at
all. `AutoSigning` reports `NotAvailable` on both the Android and iOS wallets,
so every host-routed signature costs a user tap. An ad network cannot ask for a
tap per impression.

That leaves an app-local secp256k1 key. What makes it tolerable rather than a
liability is `deriveEntropy`: if it is deterministic, the key is *regenerated*
on demand from the host's own entropy — no seed, no backup, no export, nothing
to lose. Gates 1 and 2 exist because that "if" has never been tested in a
published bundle.

## The five gates

| Gate | Question | Answered by |
|---|---|---|
| 1 | `deriveEntropy` is deterministic in a published bundle | `entropy.determinism`, `burner.derive`, `entropy.crossSession` |
| 2 | `getAnonymousAlias` is stable per product | `alias.inSession`, `alias.crossSession` |
| 3 | `getProductAccount` yields distinct keys per index | `account.productAccounts` |
| 4 | the host provider reaches the chain and reads correctly | `chain.hostTransport`, `chain.contractRead` |
| 5 | a burner-signed EIP-712 payload survives on-chain `ecrecover` | `seam.signLocal`, `seam.recoverOnChain` |

A gate passes only if **every** contributing check passes. A gate with any
contributing check skipped reads `unanswered` — never `pass`, because a gate
nobody tested is the most dangerous kind of green.

## Two of the gates need two runs

Calling `deriveEntropy` twice in one session and getting the same bytes proves
nothing a cache could not fake. The claim that matters is that the value
survives the app being closed and the WebView torn down, so the first run
records a baseline in the host's per-product store and a later run compares
against it.

**Run it, fully close the app, reopen it, and run again.** Until then gates 1
and 2 report `unanswered`, and the report says so in its caveats.

## Running it

```bash
pnpm install
pnpm --filter @broadside/contracts build     # needs tools/fetch-toolchain.sh first
pnpm --filter @broadside/seam sync-abi
pnpm --filter @broadside/seam dev            # open on a phone, or in a plain tab
```

A plain browser tab is a useful control, not a failure: the host API is absent
there, so every Bank-B-style check reports `unsupported` and what remains is the
web platform's own answer. The interesting result is the *difference* between
that and the same bundle inside the app.

## Gates 4 and 5 need a deployed contract

```bash
tools/fetch-toolchain.sh
pnpm --filter @broadside/contracts build
DEPLOYER_KEY=0x… node contracts/scripts/deploy.mjs BroadsideSeam --rpc <url>
pnpm --filter @broadside/seam sync-abi       # picks up the address
```

`deploy.mjs` deploys the **PolkaVM** blob by default. That is the point — the
question is whether `ecrecover` works under PolkaVM, not under EVM emulation.
`--evm` exists only to establish that a failure is the PolkaVM path's fault
rather than the contract's.

The deploy refuses if the contract's own `block.chainid` disagrees with the
RPC's, because a domain separator built against the wrong chain id produces
signatures that are well-formed, recoverable, and never match — with no error
anywhere to debug.

## `seam.attest` reports `skip`, and that is correct

`recover` is a `view` call, so gate 5 costs nothing and works on a device with
no funds. `attest` is the same proof as a real transaction with a real receipt,
and it needs gas the probe does not have. It reports the burner address to fund
rather than failing. Because derivation is deterministic, funding that address
once makes every later run on that device work — which is itself a small
demonstration of gate 1.

## Before publishing

```bash
pnpm --filter @broadside/seam build
pnpm --filter @broadside/seam check-identity broadsideseam.dot --env devnet
```

`check-identity` is not optional. `PRODUCT_ID` **must** equal the DotNS label:
the host derives product accounts and the local-storage namespace from it, and
allowances are looked up per product. Drift, and every host call exercises an
identity that never published anything and returns a confident "no" — not an
error, which is what makes it dangerous. sonde shipped exactly that bug on its
first publish.

`broadsideseam.dot` **is not registered.** Registration costs 11 PAS, is
permanent, and `pad` has no read-only availability query — it registers any name
the signer is eligible for, which cost sonde 33 PAS in three accidental names.
Check with `sonde/tools/whoowns.sh` before pointing `pad` at anything.

## What the probe deliberately does not publish

The raw host entropy (only its hash) and any address from `wallet.connect()`.

The burner address **is** published in full, because that is exactly what the
design claims is safe — a per-product pseudonym with no on-chain link to the
viewer's account — and because a reader has to be able to fund it. If that claim
is wrong, this report is where it shows.
