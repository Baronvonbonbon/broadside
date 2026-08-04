#!/usr/bin/env node
// Copy the client-facing slice of a contract artifact into the bundle.
//
// The bundle is published standalone to a `.dot` label and cannot reach the
// repo, so whatever it needs has to be inside it. That is an argument for
// copying — and copying is exactly what produced DATUM's worst class of bug,
// where the SDK, the WordPress plugin and the extension each carried their own
// ABI and diverged silently.
//
// So the copy is generated, never hand-edited, and `--check` fails if it is
// stale. That is the difference between a copy and a fork.
//
//   node apps/seam/scripts/sync-abi.mjs [--check]
//
// Bytecode is deliberately left behind: the app only ever reads and signs.

import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const APP = path.resolve(HERE, "..");
const ROOT = path.resolve(APP, "..", "..");
const ARTIFACT = path.join(ROOT, "contracts", "out", "BroadsideSeam.json");
const BOOK = path.join(ROOT, "contracts", "deployed-addresses.json");
const DEST = path.join(APP, "src", "generated", "seam.json");

const check = process.argv.includes("--check");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

if (!fs.existsSync(ARTIFACT)) {
  fail(`No artifact at ${path.relative(ROOT, ARTIFACT)}.\n  Run: pnpm --filter @broadside/contracts build`);
}

const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
const book = fs.existsSync(BOOK) ? JSON.parse(fs.readFileSync(BOOK, "utf8")) : {};
const deployed = book.BroadsideSeam ?? null;

const slim = {
  _generated: "apps/seam/scripts/sync-abi.mjs — do not edit; run the script",
  contract: artifact.contract,
  solc: artifact.solc,
  resolc: artifact.resolc,
  // Which blob is actually on chain. An EVM-mode deployment answers a different
  // question than a PolkaVM one, and a report that does not say which it hit
  // cannot claim ecrecover works "under PolkaVM".
  target: deployed?.target ?? null,
  address: deployed?.address ?? "",
  chainId: deployed?.chainId ?? null,
  rpc: deployed?.rpc ?? "",
  eip712: artifact.eip712 ?? null,
  abi: artifact.abi,
};

const next = JSON.stringify(slim, null, 2) + "\n";
const prev = fs.existsSync(DEST) ? fs.readFileSync(DEST, "utf8") : null;

if (check) {
  if (prev !== next) {
    fail(
      `${path.relative(ROOT, DEST)} is stale.\n` +
        `  Run: pnpm --filter @broadside/seam sync-abi`,
    );
  }
  console.log(`✓ ${path.relative(ROOT, DEST)} is current`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.writeFileSync(DEST, next);
console.log(`✓ ${path.relative(ROOT, DEST)}`);
console.log(`  address  ${slim.address || "(not deployed)"}`);
console.log(`  target   ${slim.target ?? "—"}`);
console.log(`  chainId  ${slim.chainId ?? "—"}`);
