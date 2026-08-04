#!/usr/bin/env node
// Refuse to publish a bundle whose identity does not match its label.
//
// The host derives product accounts and the local-storage namespace from
// PRODUCT_ID, and allowances are looked up per product. If PRODUCT_ID and the
// DotNS label drift apart, every host call exercises an identity that never
// published anything and returns a confident "no" — not an error. Nothing in
// the deploy output or the UI reveals it.
//
// This is not hypothetical. sonde shipped exactly that bug on its first
// publish: a bundle built as `caniuse` deployed to `caniusethis.dot`, and every
// Bank B probe reported a confident no until it was republished. This check
// exists so that cannot happen twice.
//
//   node apps/seam/scripts/check-identity.mjs <label>.dot [--env devnet]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const APP = path.resolve(HERE, "..");

const label = process.argv[2];
const envIdx = process.argv.indexOf("--env");
const env = envIdx === -1 ? null : process.argv[envIdx + 1];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(2);
}

if (!label) fail("Usage: check-identity.mjs <label>.dot [--env devnet]");

const { PRODUCT_ID, CLOUD_ENV, SEAM_ADDRESS } = await import(path.join(APP, "product.mjs"));

const expected = `${PRODUCT_ID}.dot`;
if (label !== expected) {
  fail(
    `PRODUCT_ID is "${PRODUCT_ID}", so this bundle must deploy to ${expected}, not ${label}.\n` +
      "  Change one or the other — a mismatch is silent at runtime and looks like a platform bug.",
  );
}
console.log(`✓ PRODUCT_ID matches the label   ${expected}`);

if (env && env !== CLOUD_ENV) {
  fail(
    `CLOUD_ENV is "${CLOUD_ENV}" but --env is "${env}".\n` +
      "  The SDK asks the host for that environment's chains; a devnet host build does not\n" +
      "  carry paseo-bulletin, and createApp throws rather than degrading.",
  );
}
if (env) console.log(`✓ CLOUD_ENV matches --env        ${env}`);

// A dist/ older than the sources it claims to be built from is the same class
// of silent failure: everything looks deployed and the wrong bytes are live.
const dist = path.join(APP, "dist");
if (!fs.existsSync(dist)) fail("No dist/ — run the build first.");

const newest = (dir, ignore = new Set(["node_modules", "dist"])) => {
  let latest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (ignore.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else latest = Math.max(latest, fs.statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return latest;
};

const srcTime = Math.max(
  newest(path.join(APP, "src")),
  fs.statSync(path.join(APP, "product.mjs")).mtimeMs,
  fs.statSync(path.join(APP, "index.html")).mtimeMs,
);
const distTime = newest(dist, new Set());
if (srcTime > distTime) {
  fail(
    `dist/ is older than the sources.\n` +
      `  newest source  ${new Date(srcTime).toISOString()}\n` +
      `  newest dist    ${new Date(distTime).toISOString()}\n` +
      "  Rebuild before publishing.",
  );
}
console.log(`✓ dist/ is newer than src/`);

// The generated ABI slice has to be current too — an address the app carries
// that is not the one that was deployed sends every read to empty code.
try {
  execFileSync(process.execPath, [path.join(HERE, "sync-abi.mjs"), "--check"], { stdio: "inherit" });
} catch {
  fail("The generated ABI slice is stale.");
}

console.log(
  SEAM_ADDRESS
    ? `✓ SEAM_ADDRESS set               ${SEAM_ADDRESS}`
    : "· SEAM_ADDRESS is empty — the on-chain gate will report skip rather than an answer.",
);
