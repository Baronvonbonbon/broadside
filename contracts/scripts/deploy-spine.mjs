#!/usr/bin/env node
// Deploy the alpha spine as PolkaVM blobs, wire it, and register it.
//
//   DEPLOYER_KEY=0x… node contracts/scripts/deploy-spine.mjs --rpc <url> [--dry]
//
// DATUM's deploy.ts is 3,211 lines because it stands up all 44 contracts and
// the full governance ladder. This deploys the sixteen the settlement path
// actually needs and stops, because `PLAN.md`'s Phase 2 gate is a spine that
// settles and pays — not a complete protocol.
//
// Three properties worth stating, because each cost DATUM something to learn:
//
//   Resumable. Every step records its address before the next begins, so a
//   run that dies halfway is re-run rather than restarted. On a chain where
//   each deployment is a real transaction, "start over" is not free.
//
//   Ordered by dependency, not by taste. A contract that takes another's
//   address in its constructor is deployed after it, and the wiring pass runs
//   only once every address exists — so a mis-ordered edit fails at the first
//   constructor rather than at some later setter with a zero address.
//
//   Verified after wiring. Every setter is read back. `if (address(x) != 0)`
//   is the guard style throughout these contracts, so a silently-unset pointer
//   does not fail, it *skips* — which is the failure mode this whole spine
//   exists to avoid.

import fs from "node:fs";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

const HERE = import.meta.dirname;
const CONTRACTS = path.resolve(HERE, "..");
const ROOT = path.resolve(CONTRACTS, "..");
const OUT = path.join(CONTRACTS, "out");
const BOOK = path.join(CONTRACTS, "deployed-addresses.json");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const DRY = process.argv.includes("--dry");

const GUARDIANS = (process.env.GUARDIANS ?? "").split(",").map((g) => g.trim()).filter(Boolean);
const RPC = arg("--rpc", process.env.BROADSIDE_RPC ?? "https://eth-rpc-testnet.polkadot.io/");

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

/**
 * Deployment order. Constructor dependencies only — wiring comes after.
 *
 * `args` is a function so it can read addresses deployed earlier in the same
 * run; a plain array would have to be built before anything exists.
 */
const SPINE = [
  // ── no constructor dependencies ─────────────────────────────────────────
  //
  // 2-of-3 emergency pause. The contract requires three DISTINCT non-zero
  // guardians and reverts E11 otherwise, which is correct — a 2-of-3 whose
  // three members are one key is a 1-of-1 wearing a costume. Passed in rather
  // than defaulted, because who can halt settlement is a policy decision and
  // does not belong in a fallback buried in a deploy script.
  ["BroadsidePauseRegistry", () => GUARDIANS],
  ["BroadsideBudgetLedger", () => []],
  ["BroadsidePaymentVault", () => []],
  ["BroadsidePowEngine", () => []],
  ["BroadsideNullifierRegistry", () => []],
  ["BroadsideClickRegistry", () => []],
  ["BroadsideSettlementRateLimiter", () => []],
  ["BroadsidePublisherReputation", () => []],
  ["BroadsideDualSig", () => []],
  ["BroadsideSettlementLogicA", () => []],
  ["BroadsideSettlementLogicB", () => []],
  // baseStakeWei, planckPerImpression, unstakeDelayBlocks. Alpha values: a
  // nominal bond, no per-impression component, and a one-day exit delay at 6 s
  // blocks. Real numbers wait on the calibration DATUM's launch plan defers to
  // observed abuse — guessing them here would look like a decision.
  ["BroadsidePublisherStake", () => [10n ** 18n, 0n, 14_400n]],

  // ── take another contract's address at construction ─────────────────────
  ["BroadsideCampaignLifecycle", (a) => [a.BroadsidePauseRegistry, 100_000n]],
  ["BroadsidePublishers", (a) => [0n, a.BroadsidePauseRegistry]],
  // minimumCpmFloor, pendingTimeoutBlocks, publishers, pauseRegistry
  ["BroadsideCampaigns", (a) => [10n ** 15n, 100_000n, a.BroadsidePublishers, a.BroadsidePauseRegistry]],
  ["BroadsideClaimValidator", (a) => [a.BroadsideCampaigns, a.BroadsidePublishers, a.BroadsidePauseRegistry]],
  ["BroadsideSettlement", (a) => [a.BroadsidePauseRegistry]],

  // The router resolves every other address, so it is constructed knowing the
  // two it holds as typed references and the account that governs it. Deployed
  // last for that reason, not by convention.
  ["BroadsideRouter", (a, me) => [a.BroadsideCampaigns, a.BroadsideCampaignLifecycle, me]],
];

/**
 * Router slots, by the names `@broadside/protocol` publishes.
 *
 * The key is `keccak256(slot)`, and the slot strings are the protocol
 * package's — not invented here — so the widget, relay and indexer resolve the
 * same names the router was registered with.
 */
const SLOTS = {
  settlement: "BroadsideSettlement",
  campaigns: "BroadsideCampaigns",
  publishers: "BroadsidePublishers",
  budgetLedger: "BroadsideBudgetLedger",
  paymentVault: "BroadsidePaymentVault",
  claimValidator: "BroadsideClaimValidator",
  dualSig: "BroadsideDualSig",
  pauseRegistry: "BroadsidePauseRegistry",
  campaignLifecycle: "BroadsideCampaignLifecycle",
  powEngine: "BroadsidePowEngine",
  nullifierRegistry: "BroadsideNullifierRegistry",
  clickRegistry: "BroadsideClickRegistry",
  settlementRateLimiter: "BroadsideSettlementRateLimiter",
  publisherReputation: "BroadsidePublisherReputation",
  publisherStake: "BroadsidePublisherStake",
};

const artifact = (name) => {
  const p = path.join(OUT, `${name}.json`);
  if (!fs.existsSync(p)) fail(`No artifact for ${name}. Run: pnpm --filter @broadside/contracts build`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

const book = fs.existsSync(BOOK) ? JSON.parse(fs.readFileSync(BOOK, "utf8")) : {};
const save = () => fs.writeFileSync(BOOK, JSON.stringify(book, null, 2) + "\n");

const key = process.env.DEPLOYER_KEY;
if (!key && !DRY) fail("No DEPLOYER_KEY in the environment.");
if (!DRY && GUARDIANS.length !== 3) {
  fail("GUARDIANS must be three comma-separated addresses — the pause registry is 2-of-3 and rejects duplicates.");
}
if (!DRY && new Set(GUARDIANS.map((g) => g.toLowerCase())).size !== 3) {
  fail("GUARDIANS must be three DISTINCT addresses.");
}

const provider = new JsonRpcProvider(RPC);
const wallet = key ? new Wallet(key, provider) : null;
const net = await provider.getNetwork();
const me = wallet?.address ?? "0x" + "00".repeat(20);

console.log(`\nBroadside alpha spine`);
console.log(`  rpc       ${RPC}`);
console.log(`  chainId   ${net.chainId}`);
console.log(`  deployer  ${me}`);
if (wallet) console.log(`  balance   ${(Number(await provider.getBalance(me)) / 1e18).toFixed(2)} PAS`);
if (GUARDIANS.length) console.log(`  guardians ${GUARDIANS.join("\n            ")}`);
console.log(`  target    PolkaVM\n`);

// ── deploy ──────────────────────────────────────────────────────────────────
const addr = Object.fromEntries(Object.entries(book).map(([k, v]) => [k, v.address]));
let deployed = 0;
let reused = 0;

for (const [name, argsOf] of SPINE) {
  if (addr[name]) {
    console.log(`  · ${name.padEnd(32)} ${addr[name]}  (already deployed)`);
    reused++;
    continue;
  }
  const art = artifact(name);
  if (DRY) {
    console.log(`  ? ${name.padEnd(32)} ${String(art.pvm.bytes).padStart(7)} bytes  (dry run)`);
    addr[name] = `0x${"11".repeat(20)}`;
    continue;
  }
  // Check arity against the ABI before sending. Getting this wrong costs a
  // real transaction to discover, and the ABI has known the answer all along —
  // reading the constructor out of the source with a regex is what missed
  // BroadsideRouter's three arguments and BroadsideCampaigns' four.
  const args = argsOf(addr, me);
  const ctor = art.abi.find((x) => x.type === "constructor");
  const want = ctor?.inputs?.length ?? 0;
  if (args.length !== want) {
    fail(
      `${name}: constructor takes ${want} argument(s), got ${args.length}.\n` +
        `  expected: ${(ctor?.inputs ?? []).map((i) => `${i.type} ${i.name}`).join(", ") || "(none)"}`,
    );
  }
  if (args.some((v) => v === undefined)) fail(`${name}: a constructor argument is undefined — check deployment order.`);

  const factory = new ContractFactory(art.abi, art.pvm.bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const at = await contract.getAddress();
  addr[name] = at;
  book[name] = {
    address: at,
    target: "pvm",
    chainId: Number(net.chainId),
    rpc: RPC,
    bytes: art.pvm.bytes,
    solc: art.solc,
    resolc: art.resolc,
    deployedAt: new Date().toISOString(),
    tx: contract.deploymentTransaction().hash,
  };
  save(); // before the next deploy, so a crash is resumable
  deployed++;
  console.log(`  ✓ ${name.padEnd(32)} ${at}  ${String(art.pvm.bytes).padStart(7)} bytes`);
}

console.log(`\n  ${deployed} deployed, ${reused} reused\n`);
if (DRY) {
  console.log("Dry run — nothing sent. Re-run without --dry to deploy.");
  process.exit(0);
}

// ── wire ────────────────────────────────────────────────────────────────────
const { Contract } = await import("ethers");
const at = (name) => new Contract(addr[name], artifact(name).abi, wallet);

const steps = [
  // Settlement's four structural refs. `relay_` is the account permitted to
  // submit on a viewer's behalf — the off-chain relay's key, which in alpha is
  // the deployer. It cannot be zero.
  ["Settlement.configure", () => at("BroadsideSettlement").configure(addr.BroadsideBudgetLedger, addr.BroadsidePaymentVault, addr.BroadsideCampaignLifecycle, me)],
  ["Settlement.setLogic", () => at("BroadsideSettlement").setLogic(addr.BroadsideSettlementLogicA, addr.BroadsideSettlementLogicB)],
  ["Settlement.setClaimValidator", () => at("BroadsideSettlement").setClaimValidator(addr.BroadsideClaimValidator)],
  ["Settlement.setCampaigns", () => at("BroadsideSettlement").setCampaigns(addr.BroadsideCampaigns)],
  ["Settlement.setPublishers", () => at("BroadsideSettlement").setPublishers(addr.BroadsidePublishers)],
  ["Settlement.setDualSig", () => at("BroadsideSettlement").setDualSig(addr.BroadsideDualSig)],
  // The guards. Every one of these call sites is `if (address(x) != 0)`, so an
  // unset pointer is a silently disabled protection rather than an error.
  ["Settlement.setPowEngine", () => at("BroadsideSettlement").setPowEngine(addr.BroadsidePowEngine)],
  ["Settlement.setNullifierRegistry", () => at("BroadsideSettlement").setNullifierRegistry(addr.BroadsideNullifierRegistry)],
  ["Settlement.setClickRegistry", () => at("BroadsideSettlement").setClickRegistry(addr.BroadsideClickRegistry)],
  ["Settlement.setRateLimiter", () => at("BroadsideSettlement").setRateLimiter(addr.BroadsideSettlementRateLimiter)],
  ["Settlement.setReputationContract", () => at("BroadsideSettlement").setReputationContract(addr.BroadsidePublisherReputation)],
  ["Settlement.setPublisherStake", () => at("BroadsideSettlement").setPublisherStake(addr.BroadsidePublisherStake)],
];

console.log("wiring");
const wiringFailures = [];
for (const [label, run] of steps) {
  if (book._wired?.includes(label)) {
    console.log(`  · ${label}  (already)`);
    continue;
  }
  try {
    const tx = await run();
    await tx.wait();
    book._wired = [...(book._wired ?? []), label];
    save();
    console.log(`  ✓ ${label}`);
  } catch (e) {
    const msg = (e.shortMessage ?? e.message ?? String(e)).slice(0, 120);
    wiringFailures.push(`${label}: ${msg}`);
    console.log(`  ✗ ${label}  — ${msg}`);
  }
}

// ── register in the router ──────────────────────────────────────────────────
//
// Broadside publishes ONE name to the cdm ContractRegistry — `@broadside/hub`,
// pointing here — because cdm is append-only and an entry "cannot be deleted,
// renamed or reassigned". Everything else resolves through this map, which
// governance can re-point. That registration is a separate, deliberate step and
// is not done by this script.
console.log("\nregistering slots in BroadsideRouter");
const router = at("BroadsideRouter");
for (const [slot, contractName] of Object.entries(SLOTS)) {
  const name = keccak256(toUtf8Bytes(slot));
  if (book._registered?.includes(slot)) {
    console.log(`  · ${slot}`);
    continue;
  }
  try {
    const tx = await router.register(name, addr[contractName]);
    await tx.wait();
    book._registered = [...(book._registered ?? []), slot];
    save();
    console.log(`  ✓ ${slot.padEnd(24)} → ${addr[contractName]}`);
  } catch (e) {
    const msg = (e.shortMessage ?? e.message ?? String(e)).slice(0, 120);
    wiringFailures.push(`register ${slot}: ${msg}`);
    console.log(`  ✗ ${slot.padEnd(24)} — ${msg}`);
  }
}

// ── verify ──────────────────────────────────────────────────────────────────
console.log("\nverifying");
let bad = 0;
for (const slot of Object.keys(SLOTS)) {
  const resolved = await router.currentAddrOf(keccak256(toUtf8Bytes(slot))).catch(() => null);
  const want = addr[SLOTS[slot]];
  const ok = resolved && resolved.toLowerCase() === want.toLowerCase();
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${slot.padEnd(24)} ${resolved ?? "unresolved"}`);
}

save();
console.log(`\n✓ ${path.relative(ROOT, BOOK)}`);
if (wiringFailures.length) {
  console.log(`\n${wiringFailures.length} step(s) failed:`);
  for (const f of wiringFailures) console.log(`  ${f}`);
}
if (bad) fail(`${bad} slot(s) do not resolve. The spine is deployed but not usable.`);
console.log(`\nAll ${Object.keys(SLOTS).length} slots resolve. Spine is live on chain ${net.chainId}.`);
