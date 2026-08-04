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
const ALPHA = path.resolve(arg("--src", "/home/k/Documents/datum/alpha-core"));
const SRC = path.join(ALPHA, "contracts");
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

/**
 * Every production contract, not just the alpha spine.
 *
 * The spine is eight contracts and the plan's Phase 2 gate is about deploying
 * those. But the *test suite* is the thing worth having, and DATUM's mocks and
 * fixtures reference the whole set — MockActivationBondsV2 imports
 * ActivationBonds, and so on down the graph. Porting a subset means either
 * pruning tests until the graph closes, which discards the surprises the suite
 * exists to carry, or stubbing contracts, which is more work than porting them.
 *
 * Phase 0 already measured all 56 as fitting under the blob limit, so the
 * mechanical part of Phase 5 is free here. What is *deployed* stays the spine;
 * this only decides what compiles.
 */
function productionSources() {
  const out = [];
  for (const sub of ["", "token"]) {
    const dir = path.join(SRC, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".sol")) continue;
      // Mocks are included deliberately. DATUM keeps them in two places —
      // contracts/mocks/ and top-level contracts/ — and the test suite needs
      // both; excluding "Mock" by name silently dropped fourteen of them and
      // cost 131 tests before the first assertion ran.
      out.push(path.join(sub, f));
    }
  }
  return out;
}
const SEEDS = productionSources();

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
if (!files.length) fail("Closure is empty — is --src pointing at alpha-core/?");

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

/**
 * Mocks, test helpers and the tests themselves.
 *
 * Ported wholesale rather than by closure. A test suite's value is in its
 * coverage of the cases someone already thought of and hit, and pruning it to
 * "the ones that obviously apply" discards exactly the surprises it exists to
 * carry. Tests that reference contracts not yet ported will fail to compile;
 * that is a to-do list, not a reason to leave them behind.
 */
function portTree(fromDir, toDir, filter) {
  if (!fs.existsSync(fromDir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    if (entry.isDirectory()) {
      n += portTree(from, path.join(toDir, entry.name), filter);
      continue;
    }
    if (!filter(entry.name)) continue;
    const body = fs.readFileSync(from, "utf8");
    const ported = renameIdentifiers(body)
      .replace(/(from\s+"|import\s+")(\.[^"]+)"/g, (m, pre, spec) => {
        const slash = spec.lastIndexOf("/");
        return `${pre}${spec.slice(0, slash + 1)}${renameFile(spec.slice(slash + 1))}"`;
      })
      // hardhat identifies a compiled unit by its *source name*, which is the
      // path relative to `paths.sources`. DATUM keeps contracts in
      // `contracts/`; this repo keeps them in `contracts/src/`, so the two
      // storage-layout tests — the ones that guard the DELEGATECALL slot
      // invariant, and therefore the only reason the Settlement split is safe —
      // look up a build-info key that does not exist and fail before their
      // first assertion. A path rename, no different in kind from the others.
      .replace(/([`"])contracts\//g, "$1src/");
    if (!DRY) {
      fs.mkdirSync(toDir, { recursive: true });
      fs.writeFileSync(path.join(toDir, renameFile(entry.name)), ported);
    }
    n++;
  }
  return n;
}

const CONTRACTS_DIR = path.join(ROOT, "contracts");
const mocks = portTree(path.join(SRC, "mocks"), path.join(OUT, "mocks"), (f) => f.endsWith(".sol"));
const helpers = portTree(path.join(ALPHA, "test", "helpers"), path.join(CONTRACTS_DIR, "test", "helpers"), (f) => f.endsWith(".ts"));
const tests = portTree(path.join(ALPHA, "test"), path.join(CONTRACTS_DIR, "test"), (f) => f.endsWith(".test.ts"));

// The committed storage-layout snapshot. settlement-layout.test.ts diffs the
// live layout against it, which is what turns "the three contracts agree with
// each other" into "they agree with what was reviewed" — a stronger claim, and
// the one that matters when the DELEGATECALL split is the thing keeping
// Settlement deployable.
const snapshotSrc = path.join(ALPHA, "settlement-layout.snapshot.json");
let snapshots = 0;
if (fs.existsSync(snapshotSrc)) {
  const ported = renameIdentifiers(fs.readFileSync(snapshotSrc, "utf8")).replaceAll("contracts/", "src/");
  if (!DRY) fs.writeFileSync(path.join(CONTRACTS_DIR, "settlement-layout.snapshot.json"), ported);
  snapshots = 1;
}

console.log(`${DRY ? "would port" : "ported"} ${written.length} contract(s), ${lines.toLocaleString()} lines`);
console.log(`  + ${mocks} mock(s), ${helpers} test helper(s), ${tests} test file(s), ${snapshots} layout snapshot`);
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
