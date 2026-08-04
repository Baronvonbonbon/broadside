/**
 * The report. Two forms of the same data: JSON to diff, markdown to read.
 *
 * A single run of this probe is an anecdote. Two runs — before and after an app
 * restart, or on two devices — are evidence, and only if they can be compared
 * mechanically. So the JSON is the artifact and the markdown is a rendering of
 * it, never the other way round.
 *
 * What is deliberately *not* in here: the raw host entropy, and any address
 * from `wallet.connect()`. The burner address is included in full because
 * publishing it is precisely what the design claims is safe — it is a
 * per-product pseudonym with no on-chain link to the viewer's account — and
 * because a reader has to be able to fund it. If that claim is wrong, this
 * report is where it shows.
 */

import { PRODUCT_ID, SOURCE_URL, SUITE_VERSION } from "../product.mjs";
import { CONTRACT_ADDRESS, CONTRACT_CHAIN_ID, CONTRACT_TARGET } from "./seam";
import { GATES, type Finding, type GateId, type Status } from "./types";
import { CHECKS } from "./checks";

declare const __BUILD_ID__: string;

export type GateVerdict = "pass" | "fail" | "unanswered";

export interface Report {
  suite: "broadside-seam";
  suiteVersion: string;
  buildId: string;
  productId: string;
  source: string;
  ranAt: string;
  surface: {
    userAgent: string;
    inContainer: boolean;
    /** Where the cross-session baseline lives, which decides what it can prove. */
    baselineStore: string;
    baselineRecordedAt: string | null;
  };
  /** The contract under test. Which chain the *host* carries is discovered per
   *  run and lives in `chain.hostSupports`, not here — it is a property of the
   *  host build, not of this deployment. */
  target: {
    contract: string;
    contractChainId: number | null;
    contractTarget: string | null;
  };
  gates: Record<GateId, { question: string; verdict: GateVerdict; from: string[] }>;
  findings: Finding[];
  caveats: string[];
}

/**
 * `JSON.stringify` that survives what actually ends up in a finding.
 *
 * ethers decodes a `uint256` to a **BigInt**, and `JSON.stringify` throws
 * outright on one — `TypeError: Do not know how to serialize a BigInt`. That
 * single unhandled throw escaped onProgress, unwound the whole run, and left the
 * in-flight row on screen forever. Six runs were spent reading it as a network
 * hang: the elapsed counter froze because nothing was scheduling it any more,
 * and the check's own timeout never fired because the check had already
 * finished, successfully.
 *
 * A report that cannot serialize its own evidence is worse than one that omits
 * it, so this converts rather than throws — and does the same for the other two
 * shapes that reach here from the host bridge.
 */
export function safeStringify(value: unknown, indent = 2): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return `${v}`;
      if (v instanceof Uint8Array) return `0x${Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      return v;
    },
    indent,
  );
}

export function build(findings: Finding[], surface: Report["surface"]): Report {
  return {
    suite: "broadside-seam",
    suiteVersion: SUITE_VERSION,
    buildId: typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev",
    productId: PRODUCT_ID,
    source: SOURCE_URL,
    ranAt: new Date().toISOString(),
    surface,
    target: {
      contract: CONTRACT_ADDRESS || "(not deployed)",
      contractChainId: CONTRACT_CHAIN_ID,
      contractTarget: CONTRACT_TARGET,
    },
    gates: verdicts(findings),
    findings,
    caveats: caveats(findings, surface),
  };
}

/**
 * A gate passes only if every check feeding it passes. A gate with any
 * contributing check skipped is `unanswered` — not `fail`, because nothing was
 * measured, and not `pass`, because a gate nobody tested is the most dangerous
 * kind of green.
 */
function verdicts(findings: Finding[]): Report["gates"] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const out = {} as Report["gates"];

  for (const gate of Object.keys(GATES) as GateId[]) {
    const contributing = CHECKS.filter((c) => c.gates.includes(gate)).map((c) => c.id);
    const results = contributing.map((id) => byId.get(id)?.status ?? "skip");
    const verdict: GateVerdict = results.some((s) => s === "fail")
      ? "fail"
      : results.every((s) => s === "pass") && results.length > 0
        ? "pass"
        : "unanswered";
    out[gate] = { question: GATES[gate], verdict, from: contributing };
  }
  return out;
}

function caveats(findings: Finding[], surface: Report["surface"]): string[] {
  const out: string[] = [];

  if (!surface.inContainer) {
    out.push(
      "Not run inside the Polkadot App. Every host answer here describes a plain browser or the gateway iframe, which is a different surface — this report cannot speak to the app's behaviour.",
    );
  }
  if (!surface.baselineRecordedAt) {
    out.push(
      "First run on this device: the cross-session checks recorded a baseline instead of comparing against one. Two of the five gates stay unanswered until the app is fully closed, reopened, and the probe run again.",
    );
  }
  if (surface.baselineStore === "web") {
    out.push(
      "The baseline is in window.localStorage, not the host store. Clearing site data resets it, and it does not follow the product identity.",
    );
  }
  if (surface.baselineStore === "none") {
    out.push("No storage was available, so nothing was recorded and no cross-session claim can ever be made from this run.");
  }
  if (!CONTRACT_ADDRESS) {
    out.push("BroadsideSeam is not deployed. The on-chain recovery gate — the one this probe exists for — was not tested.");
  }
  if (findings.some((f) => f.status === "fail" && f.diagnosis === "host-call-failed" && f.detail.includes("Never settled"))) {
    out.push(
      "A host call never settled. Promise.race does not cancel the losing promise, so that call is still pending for the life of this page; its resources are released and the run moved on, but a later result may be affected by it.",
    );
  }
  return out;
}

const MARK: Record<Status, string> = {
  pass: "✓",
  fail: "✗",
  unsupported: "—",
  blocked: "⊘",
  skip: "·",
};

const GATE_MARK: Record<GateVerdict, string> = { pass: "✓", fail: "✗", unanswered: "?" };

export function toMarkdown(r: Report): string {
  const L: string[] = [];
  L.push(`# Phase 1 — seam probe report`, "");
  L.push(`- suite \`${r.suite}\` ${r.suiteVersion}, build \`${r.buildId}\``);
  L.push(`- product \`${r.productId}\`, ran ${r.ranAt}`);
  L.push(`- surface: ${r.surface.inContainer ? "**Polkadot App**" : "plain browser / gateway"} — \`${r.surface.userAgent}\``);
  L.push(`- contract: \`${r.target.contract}\` (${r.target.contractTarget ?? "?"}) on chain ${r.target.contractChainId ?? "?"}`);
  L.push(`- source: ${r.source}`, "");

  L.push(`## Gates`, "");
  L.push(`| | Question | Verdict |`, `|---|---|---|`);
  for (const g of Object.values(r.gates)) {
    L.push(`| ${GATE_MARK[g.verdict]} | ${g.question} | **${g.verdict}** |`);
  }
  L.push("");

  L.push(`## Findings`, "");
  L.push(`| | Check | Result | ms |`, `|---|---|---|---:|`);
  for (const f of r.findings) {
    L.push(`| ${MARK[f.status]} | \`${f.id}\` | ${f.status}${f.diagnosis ? ` · ${f.diagnosis}` : ""} | ${f.ms ?? ""} |`);
  }
  L.push("");

  for (const f of r.findings) {
    L.push(`### ${MARK[f.status]} ${f.title}`, "");
    L.push(`\`${f.id}\` — **${f.status}**${f.diagnosis ? ` (\`${f.diagnosis}\`)` : ""}`, "");
    L.push(`*Why it matters:* ${f.why}`, "");
    L.push(f.detail, "");
    if (f.data && Object.keys(f.data).length) {
      L.push("```json", safeStringify(f.data), "```", "");
    }
  }

  if (r.caveats.length) {
    L.push(`## Caveats`, "");
    for (const c of r.caveats) L.push(`- ${c}`);
    L.push("");
  }
  return L.join("\n");
}

export function download(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoked on the next tick rather than immediately: some WebViews start the
  // download asynchronously and a revoked URL yields a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
