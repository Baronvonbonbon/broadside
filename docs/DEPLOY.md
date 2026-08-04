# Deploying Broadside

Two independent things get deployed, and confusing them wastes a day: **contracts** go to a
pallet-revive chain over Ethereum RPC, and the **Product bundle** goes to the Bulletin chain under a
`.dot` name. They have different tools, different accounts, and different failure modes.

## Identity

| | |
|---|---|
| DotNS label | `broadside.dot` |
| Environment | `devnet` |
| Gateway | <https://broadside.dev-dot.li> |
| Owner (H160) | `0xff54a5a1fdac91bb4f2b4fbf4bfff37cdbea333f` |
| Owner (root SS58) | `5DoMJAZMGSJfTpC2hV4irP9G4R1iSoJvKq1xriPa984TLT43` |

`PRODUCT_ID` in `apps/seam/product.mjs` **must** equal the label. The host derives product accounts
and the local-storage namespace from it, and allowances are looked up per product; if the two drift,
every host call exercises an identity that never published anything and returns a confident "no" —
not an error, which is what makes it dangerous. `apps/seam/scripts/check-identity.mjs` enforces it
and refuses a `dist/` older than its sources.

The flagship name is deliberately spent on a throwaway probe. The name is permanent and the
contenthash behind it is not, so it gets registered once and re-pointed at the real product later —
and the baseline the probe records then sits under the same product identity the widget will use,
which is what makes its answers transferable instead of a measurement of some other product.

## Deployment record

### 2026-08-04 — contracts

| | |
|---|---|
| `BroadsideSeam` | `0xbcb6C034923130b66E7596E778d6D56c283a77B7` |
| Chain | 420420417 via `https://eth-rpc-testnet.polkadot.io/` |
| Target | **native PolkaVM**, 15,932 bytes (confirmed against `eth_getCode`) |
| Deploy tx | `0xfb91ce63292e76beff85ec9c225f323c96d12f0db1b6906867f4b0f5c4d796f6` |
| Deployer | `0x26194fE2e00A837b2a3f4e92A09E835AbB3DCEE3` (shared with DATUM and FARE) |
| Verified by | `node contracts/scripts/verify-seam.mjs --write` — 7/7 |

### 2026-08-04 — `broadside.dot`, initial publish

| | |
|---|---|
| CID | `bafybeifqyvii2d3ojbworfui56v6infhaywjmucmgkzz2v7mqnezk63i7e` |
| Content tx | `0x66477084627c0fbdd54969485a99bb54e4a015d28c8416738fb925186436560c` @ block 11808399 |
| Hand-over tx | `0xb0b5e920050a645f4501beef709d7251ef039a5b7cdb6d5c6f7febb324047d43` |
| P2P retrieval | ✓ 187 ms |
| Payload | `apps/seam/dist` |

**Two expectations this publish contradicted, both worth writing down.**

*It was not personhood-gated.* `ascend` recorded that a `NoStatus` signer can only take a label of
"≥ 9 characters with exactly two trailing digits" — hence `ascendyendor00.dot`. `broadside` is
exactly 9 characters with **no** trailing digits and registered without complaint. Either the rule is
narrower than ascend's note, or this signer's status is not `NoStatus`. Do not plan around either
version of the rule; ask.

*The signed-in account paid nothing.* Its balance was 0.4900 PAS before and 0.4900 PAS after.
`pad` registers with a funded **local worker** and then hands the name over, which is why a nearly
empty signer could still take a name that cost `sonde` 11 PAS. Budgeting for a registration against
the signer's own balance would have been wrong.

## Publishing

```bash
pnpm --filter @broadside/seam build
pnpm --filter @broadside/seam check-identity broadside.dot --env devnet
pnpm dlx @polkadot-community-foundation/polkadot-app-deploy@latest \
    ./apps/seam/dist broadside.dot --env devnet --js-merkle
```

### Republishing needs a phone — the first publish did not

The name is now owned by the signed-in account, so updating its contenthash is a transaction only
that account can sign:

```
You already own broadside.dot — updating its content needs your signature.
Check your phone → Link content
Press Y when ready (Ctrl-C to abort):
```

There is no non-interactive path. **Run republishes in an interactive terminal.** Two ways it fails
in automation, both leaving the upload done and only the link missing:

- **stdin closed** → the prompt reads EOF → `Deployment failed: aborted by user`
- **`yes | pad …`** → `No signature received from the phone`. Pressing Y does not raise the phone
  prompt; it asserts *"I have already approved"* and makes `pad` go collect a signature. Answering
  early guarantees there is nothing to collect.

Uploads are incremental and content-addressed, so an aborted link is cheap to retry.

### Bulletin retention is ~2 weeks

A published bundle decays. Either renew it or treat each publish as a dated snapshot — the probe's
report carries the build id, so an old report stays interpretable after the bundle stops resolving.
`ascend` runs a weekly cron for exactly this; Broadside will need one before anything depends on the
bundle staying up.

### The gateway serves a loader, not the bundle

`curl https://broadside.dev-dot.li` returns Parity's client-side loader (~20 KB), not the app's HTML
— the bundle is fetched from Bulletin into a sandboxed iframe. `P2P retrieval: ✓` in the deploy
output is the real confirmation. That iframe **is** the gateway surface: sandboxed, no host API,
subject to the embedder's Permissions-Policy, and therefore a useful control to diff against the
in-app run.

## Never point `pad` at a name to "see what happens"

`pad` has no read-only availability query, and for a name the signer is eligible for, preflight
passes and it **registers** — permanently, first-come, and DotNS entries "cannot be deleted, renamed
or reassigned." Running it in a loop over candidate names cost `sonde` 33 PAS in three names nobody
wanted. Use `sonde/tools/whoowns.sh`, and read its source first: it races a `kill` against the
registration step, so it is safer than `pad` but not safe.

## Contracts

```bash
tools/fetch-toolchain.sh                       # pinned, checksum-verified solc + resolc
pnpm --filter @broadside/contracts build       # both targets; fails if PVM exceeds 256 KiB
DEPLOYER_KEY=0x… node contracts/scripts/deploy.mjs BroadsideSeam --rpc <url>
node contracts/scripts/verify-seam.mjs --write
pnpm --filter @broadside/seam sync-abi         # carry the address into the bundle
```

`deploy.mjs` ships the **PolkaVM** blob by default — the question this repo exists to answer is
whether things work under PolkaVM, not under EVM emulation. `--evm` exists only to localise a
failure to the PolkaVM path.

It refuses if the contract's own `block.chainid` disagrees with the RPC's, because a domain
separator built against the wrong chain id yields signatures that are well-formed, recoverable, and
never match — with no error anywhere to debug.

**The deployer is not `//Alice`.** `datum/alpha-core/.env` and `fare/.env` share one real personal
key. Anything deployed with it is controlled by whoever holds that file.
