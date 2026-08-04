#!/usr/bin/env node
// Port DATUM's contract sources into contracts/src, renamed.
//
//   node tools/port-from-datum.mjs [--src <alpha-core>] [--dry]
//
// A script rather than an afternoon of find-and-replace, for three reasons.
// It is re-runnable, so a fix upstream can be pulled forward without redoing
// the rename by hand. It is reviewable, so the rename rules are a diff instead
// of a claim. And it is honest about what it cannot do: the Settlement collapse
// is a real refactor, not a substitution, and this script deliberately refuses
// to pretend otherwise — see MERGED below.
//
// What it does NOT touch: error codes. `E00`, `E28`, `E32` and the rest are
// parsed by clients and are not brand strings. Renumbering them would be a
// breaking change disguised as a cleanup.

import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "contracts", "src");
// The halves of the Settlement split land here, renamed but outside src/ so the
// build never compiles them. They are the input to the merge, not an output of
// it — keeping them under src/ would produce three contracts where the whole
// point is to ship one.
const STAGING = path.join(ROOT, "contracts", ".port-staging");

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SRC = path.resolve(arg("--src", "/home/k/Documents/datum/alpha-core/contracts"));
const DRY = process.argv.includes("--dry");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}
if (!fs.existsSync(SRC)) fail(`No source at ${SRC}`);

/**
 * Renames that are not `Datum` → `Broadside`.
 *
 * Applied before the general rule, because the general rule would otherwise
 * produce `BroadsideGovernanceRouter` and `BroadsideDualSigSettlement` — names
 * that carry DATUM's history rather than describing what the contract does.
 */
const EXPLICIT = [
  // The router registers the ONE cdm name and re-points everything else. It is
  // not governance; governance is a separate contract that uses it.
  ["DatumGovernanceRouter", "BroadsideRouter"],
  ["IDatumGovernanceRouter", "IBroadsideRouter"],
  // "DualSigSettlement" reads as a second settlement contract. It is the
  // signature-verification entry point for the one that exists.
  ["DatumDualSigSettlement", "BroadsideDualSig"],
  ["IDatumDualSigSettlement", "IBroadsideDualSig"],
  // There is no V1 to disambiguate from — recorded in protocol/registry.ts.
  ["DatumGovernanceV2", "BroadsideGovernance"],
  ["IDatumGovernanceV2", "IBroadsideGovernance"],
];

/**
 * Sources that were going to collapse into one contract, and no longer are.
 *
 * The plan called for merging the Settlement trio, on the reasoning that the
 * three-way DELEGATECALL split exists only to satisfy EIP-170 and PolkaVM's
 * ceiling is 10.6x larger. The merge was built and measured, and the estimate
 * was wrong by more than 2x:
 *
 *   split    76,791 + 37,642 + 129,364  =  243,797 B  (all three fit)
 *   merged                                 363,578 B  (138.7% — rejected)
 *
 * Merged is LARGER THAN THE SUM. `_processBatch` is a 640-line function with
 * three call sites, and one contract lets the optimiser inline it at each —
 * `--optimize-runs 1` moves the figure by 0.6%, so this is structural, not a
 * flag. The split survives the port; only its justification changes, from
 * EIP-170 to the blob limit.
 *
 * Empty, therefore. Kept as the record of a decision that measurement reversed.
 */
const MERGED = {};

const SEEDS = [
  "DatumGovernanceRouter.sol",
  "DatumSettlement.sol",
  "DatumSettlementLogicA.sol",
  "DatumSettlementLogicB.sol",
  "DatumCampaigns.sol",
  "DatumPublishers.sol",
  "DatumBudgetLedger.sol",
  "DatumPaymentVault.sol",
  "DatumDualSigSettlement.sol",
  "DatumClaimValidator.sol",

  // The guards the settlement path actually consults. PLAN.md lists these as
  // "splits that must survive" — each is a distinct upgrade path, not a size
  // workaround — and LogicB calls into them per claim. Porting the interface
  // without the implementation leaves the slot at zero, and every one of these
  // call sites is written `if (address(x) != address(0))`, so the guard would
  // silently do nothing rather than fail. That is the worst of both worlds:
  // the code reads as protected and is not.
  "DatumPowEngine.sol",             // Sybil resistance for the anonymous tier
  "DatumNullifierRegistry.sol",     // per-campaign replay guard, PoW's other half
  "DatumPauseRegistry.sol",         // 2-of-3 guardian emergency stop
  "DatumClickRegistry.sol",         // click-action dedup
  "DatumSettlementRateLimiter.sol", // per-publisher per-window cap
  "DatumPublisherReputation.sol",   // settlement acceptance counters
  "DatumPublisherStake.sol",        // Publishers' bonding curve
  "DatumCampaignLifecycle.sol",     // status transitions, referenced by Router
];

/** Transitive local imports, so nothing is missed and nothing extra comes along. */
function closure(seeds) {
  const seen = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const rel = path.normalize(queue.pop());
    if (seen.has(rel)) continue;
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) continue; // node_modules / OZ imports
    seen.add(rel);
    const body = fs.readFileSync(abs, "utf8");
    for (const [, imp] of body.matchAll(/import\s+(?:\{[^}]*\}\s+from\s+)?"([^"]+)"/g)) {
      if (imp.startsWith("@")) continue;
      queue.push(path.normalize(path.join(path.dirname(rel), imp)));
    }
  }
  return [...seen].sort();
}

function renameIdentifiers(text) {
  let out = text;
  for (const [from, to] of EXPLICIT) {
    out = out.replaceAll(from, to);
  }
  // Word-boundaried so `DatumSettlementStorage` inside a longer identifier is
  // still caught, but a bare "datum" in prose is not mangled into nonsense.
  out = out.replace(/\bIDatum([A-Z][A-Za-z0-9]*)/g, "IBroadside$1");
  out = out.replace(/\bDatum([A-Z][A-Za-z0-9]*)/g, "Broadside$1");
  return out;
}

function renameFile(name) {
  for (const [from, to] of EXPLICIT) {
    if (name.startsWith(from)) return name.replace(from, to);
  }
  if (name.startsWith("IDatum")) return name.replace(/^IDatum/, "IBroadside");
  if (name.startsWith("Datum")) return name.replace(/^Datum/, "Broadside");
  return name;
}

const files = closure(SEEDS);
if (!files.length) fail("Closure is empty — is --src pointing at contracts/?");

const written = [];
const skipped = [];
let lines = 0;

for (const rel of files) {
  const base = path.basename(rel);
  const body = fs.readFileSync(path.join(SRC, rel), "utf8");
  const staged = base in MERGED && MERGED[base] === null;
  const target = path.join(path.dirname(rel), renameFile(base));
  const dest = path.join(staged ? STAGING : OUT, target);
  const ported = renameIdentifiers(body)
    // Rewrite imports of the files that no longer exist under their old names.
    //
    // Done by hand rather than with path.join, which normalises "./Foo.sol" to
    // "Foo.sol" — and solc treats a bare name as a search-path lookup, not a
    // sibling file, so every rewritten import fails to resolve.
    .replace(/import\s+"(\.[^"]+)"/g, (m, spec) => {
      const slash = spec.lastIndexOf("/");
      const dir = spec.slice(0, slash + 1);
      return m.replace(spec, dir + renameFile(spec.slice(slash + 1)));
    });

  lines += ported.split("\n").length;
  if (!DRY) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, ported);
  }
  (staged ? skipped : written).push(staged ? `${target} → .port-staging/ (merge input)` : target);
}

console.log(`${DRY ? "would port" : "ported"} ${written.length} file(s), ${lines.toLocaleString()} lines`);
console.log(`  from ${SRC}`);
console.log(`  to   ${path.relative(ROOT, OUT)}/\n`);
for (const s of skipped) console.log(`  skip  ${s}`);
console.log(`
The Settlement collapse is NOT done by this script. LogicA and LogicB were
copied nowhere; BroadsideSettlement.sol is DATUM's shell and still contains
setLogic, _delegateToLogicA, and dispatchers that delegatecall into contracts
that no longer exist. Merging them is a refactor with real decisions in it —
which functions become internal, what replaces the layout-snapshot test — and a
regex that pretended otherwise would produce something that compiles and is
wrong.`);
