#!/usr/bin/env node
// Collapse the Settlement trio into one contract.
//
//   node tools/merge-settlement.mjs [--check]
//
// DATUM splits Settlement three ways — Storage + LogicA + LogicB, wired by
// DELEGATECALL over a shared layout — for exactly one reason: EIP-170's
// 24,576-byte contract limit, against which the EVM build sits at 24,363 with
// 213 bytes to spare. pallet-revive's ceiling is 256 KiB. The split buys
// nothing here and costs a storage-layout invariant, two extra deployments, a
// chained delegatecall on the hot path, and a whole class of bug where the
// three drift apart.
//
// This is a refactor, not a rename, so it is a separate script from
// port-from-datum.mjs and it asserts on every anchor it edits. If DATUM's
// sources move, this fails loudly rather than producing something that compiles
// and settles claims incorrectly.
//
// The seam is narrow, which is what makes it safe:
//
//   before  Settlement.settleClaims → delegatecall LogicA.settleClaims
//                                   → delegatecall LogicB.processBatch
//   after   Settlement.settleClaims → _processBatch, an internal call
//
// `_delegateProcessBatch` keeps its name and its accumulate-into-result
// semantics; only its body changes. Every call site is therefore untouched,
// which is the difference between a merge that can be reviewed and one that
// has to be re-derived.

import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "contracts", "src");
const STAGING = path.join(ROOT, "contracts", ".port-staging");
const CHECK = process.argv.includes("--check");

const read = (p) => fs.readFileSync(p, "utf8");
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}
/** Every edit asserts. A silent no-op here is a contract that delegatecalls into nothing. */
function must(cond, what) {
  if (!cond) fail(`anchor not found: ${what}\n  DATUM's sources have moved; re-read the merge before trusting it.`);
}

const settlementPath = path.join(SRC, "BroadsideSettlement.sol");
const storagePath = path.join(SRC, "BroadsideSettlementStorage.sol");
const logicAPath = path.join(STAGING, "BroadsideSettlementLogicA.sol");
const logicBPath = path.join(STAGING, "BroadsideSettlementLogicB.sol");

for (const p of [settlementPath, storagePath, logicAPath, logicBPath]) {
  if (!fs.existsSync(p)) fail(`missing ${path.relative(ROOT, p)} — run tools/port-from-datum.mjs first`);
}

let settlement = read(settlementPath);
let storage = read(storagePath);
const logicA = read(logicAPath);
const logicB = read(logicBPath);

if (settlement.includes("_processBatch(") && !settlement.includes("_delegateToLogicA")) {
  console.log("Already merged — nothing to do.");
  process.exit(0);
}

// ── extract: LogicA's two entry points ──────────────────────────────────────
//
// Taken whole, guards included. `nonReentrant` and `whenNotFrozen` sat on
// LogicA's entry rather than the shell precisely so the shared `_status` slot
// was not double-locked across the delegatecall; with one contract they simply
// sit on the entry point, which is where they always belonged.
const aStart = logicA.indexOf("    /// @notice Single-user, many-batches relay path.");
must(aStart !== -1, "LogicA settleClaims doc block");
const aEnd = logicA.lastIndexOf("}");
const logicABodies = logicA
  .slice(aStart, aEnd)
  .replace(/BroadsideSettlementLogicB/g, "the inlined pipeline")
  .trimEnd();

// ── extract: LogicB's processBatch, as an internal ──────────────────────────
const bStart = logicB.indexOf("    function processBatch(");
must(bStart !== -1, "LogicB processBatch");
const bDocStart = logicB.lastIndexOf("    /", bStart) === -1 ? bStart : logicB.lastIndexOf("\n\n", bStart) + 2;
const bEnd = logicB.lastIndexOf("}");
const logicBBody = logicB
  .slice(bDocStart, bEnd)
  .replace(
    "    function processBatch(\n        address user,\n        uint256 campaignId,\n        IBroadsideSettlement.Claim[] calldata claims,\n        bool advertiserConsented\n    ) external returns (uint256 settled, uint256 rejected, uint256 paid) {",
    "    function _processBatch(\n        address user,\n        uint256 campaignId,\n        IBroadsideSettlement.Claim[] calldata claims,\n        bool advertiserConsented\n    ) internal override returns (uint256 settled, uint256 rejected, uint256 paid) {",
  )
  .trimEnd();
must(logicBBody.includes("function _processBatch("), "processBatch signature rewrite");

// ── patch: the storage base ─────────────────────────────────────────────────
//
// The DELEGATECALL machinery goes; the accumulator stays. Keeping
// `_delegateProcessBatch`'s name and semantics is deliberate — the dual-sig
// path and the relay loops both call it, and changing the name to match the new
// mechanism would touch call sites this merge has no reason to touch.
const ifaceStart = storage.indexOf("interface IBroadsideSettlementLogicB_processBatch {");
must(ifaceStart !== -1, "LogicB dispatch interface");
const ifaceEnd = storage.indexOf("}", ifaceStart) + 1;
storage = storage.slice(0, ifaceStart) + storage.slice(ifaceEnd);

const delegStart = storage.indexOf("    function _delegateProcessBatch(");
must(delegStart !== -1, "_delegateProcessBatch");
const delegEnd = storage.indexOf("\n    }", delegStart) + "\n    }".length;
storage =
  storage.slice(0, delegStart) +
  `    /// @dev The per-claim pipeline, implemented by BroadsideSettlement.
    ///      Declared here so this base can host the accumulator below while the
    ///      body lives on the concrete contract.
    function _processBatch(
        address user,
        uint256 campaignId,
        IBroadsideSettlement.Claim[] calldata claims,
        bool advertiserConsented
    ) internal virtual returns (uint256 settled, uint256 rejected, uint256 paid);

    /// @dev Run one batch and accumulate into \`result\`.
    ///
    ///      Was a DELEGATECALL into BroadsideSettlementLogicB, which existed
    ///      only because the EVM build had 213 bytes of headroom under EIP-170.
    ///      PolkaVM's ceiling is 256 KiB, so the call is direct and the
    ///      layout invariant that made the split dangerous is gone with it.
    ///      Name and accumulate semantics are unchanged so call sites are not.
    function _delegateProcessBatch(
        address user,
        uint256 campaignId,
        IBroadsideSettlement.Claim[] calldata claims,
        bool advertiserConsented,
        IBroadsideSettlement.SettlementResult memory result
    ) internal {
        (uint256 s, uint256 r, uint256 p) = _processBatch(user, campaignId, claims, advertiserConsented);
        result.settledCount  += s;
        result.rejectedCount += r;
        result.totalPaid     += p;
    }` +
  storage.slice(delegEnd);

// The logic pointers, their lock, and their events describe a mechanism that no
// longer exists. A clean-break deploy has no layout to preserve, so they go.
for (const [pattern, what] of [
  [/\n *address internal _logicA;/, "_logicA slot"],
  [/\n *address internal _logicB;/, "_logicB slot"],
  [/\n *bool internal _logicLocked;/, "_logicLocked slot"],
  [/\n *event LogicSet\(address indexed logicA, address indexed logicB\);/, "LogicSet event"],
  [/\n *event LogicLocked\(\);/, "LogicLocked event"],
]) {
  must(pattern.test(storage), what);
  storage = storage.replace(pattern, "");
}

// ── patch: the shell ────────────────────────────────────────────────────────
function cut(text, startAnchor, what) {
  const i = text.indexOf(startAnchor);
  must(i !== -1, what);
  const end = text.indexOf("\n    }", i) + "\n    }".length;
  return text.slice(0, i) + text.slice(end);
}

settlement = cut(settlement, "    function setLogic(address logicA_, address logicB_) external onlyOwner {", "setLogic");
settlement = cut(settlement, "    function lockLogic() external onlyOwner whenOpenGovPhase {", "lockLogic");
settlement = cut(settlement, "    function _delegateToLogicA() internal returns (SettlementResult memory) {", "_delegateToLogicA");

for (const [pattern, what] of [
  [/\n *function logicA\(\) external view returns \(address\) \{ return _logicA; \}/, "logicA getter"],
  [/\n *function logicB\(\) external view returns \(address\) \{ return _logicB; \}/, "logicB getter"],
  [/\n *function logicLocked\(\) external view returns \(bool\) \{ return _logicLocked; \}/, "logicLocked getter"],
]) {
  must(pattern.test(settlement), what);
  settlement = settlement.replace(pattern, "");
}

// Replace both thin dispatchers with LogicA's real bodies.
const dispStart = settlement.indexOf("    /// @inheritdoc IBroadsideSettlement\n    /// @dev Thin dispatcher.");
must(dispStart !== -1, "settleClaims dispatcher doc block");
const dispEnd = settlement.indexOf("    /// @notice Wire the carved-out DualSig settlement module.");
must(dispEnd !== -1 && dispEnd > dispStart, "setDualSig anchor");
settlement =
  settlement.slice(0, dispStart) +
  `    // ─────────────────────────────────────────────────────────────────────
    // Settlement entry points.
    //
    // These were thin dispatchers that DELEGATECALLed into
    // BroadsideSettlementLogicA, which DELEGATECALLed into LogicB. Both hops
    // existed to fit EIP-170 and neither survives the move to PolkaVM. The
    // bodies below are LogicA's, verbatim; the pipeline they drive is
    // \`_processBatch\` at the bottom of this file, which is LogicB's.
    // ─────────────────────────────────────────────────────────────────────

${logicABodies}

` +
  settlement.slice(dispEnd);

// Append the pipeline just inside the closing brace.
const lastBrace = settlement.lastIndexOf("}");
settlement =
  settlement.slice(0, lastBrace) +
  `
    // ─────────────────────────────────────────────────────────────────────
    // The per-claim pipeline — formerly BroadsideSettlementLogicB.
    // ─────────────────────────────────────────────────────────────────────

${logicBBody}
` +
  settlement.slice(lastBrace);

if (CHECK) {
  const same = read(settlementPath) === settlement && read(storagePath) === storage;
  console.log(same ? "✓ merge is current" : "✗ merge is stale — re-run tools/merge-settlement.mjs");
  process.exit(same ? 0 : 1);
}

fs.writeFileSync(settlementPath, settlement);
fs.writeFileSync(storagePath, storage);

const count = (s) => s.split("\n").length;
console.log(`✓ merged the Settlement trio into one contract`);
console.log(`  BroadsideSettlement.sol         ${count(settlement).toLocaleString()} lines`);
console.log(`  BroadsideSettlementStorage.sol  ${count(storage).toLocaleString()} lines`);
console.log(`  absorbed: LogicA (${count(logicA)} lines) + LogicB (${count(logicB)} lines)`);
console.log(`\nNow measure it: node contracts/scripts/build.mjs`);
