/**
 * The shell. One button, five verdicts, sixteen findings, two downloads.
 *
 * Built for a phone held by someone who did not write it: the gates are the
 * headline because they are the question, the findings are underneath because
 * they are the evidence, and the raw JSON is one tap away because a report
 * nobody can check is a rumour.
 */

import { isInsideContainerSync } from "@parity/product-sdk";
import { DOT_NAME, PRODUCT_ID, SOURCE_URL } from "../product.mjs";
import { build, download, toMarkdown, type Report } from "./report";
import { runAll } from "./run";
import { extend, openStore, type Baseline } from "./memory";
import type { Finding, Status } from "./types";
import "./style.css";

declare const __BUILD_ID__: string;

const MARK: Record<Status, string> = { pass: "✓", fail: "✗", unsupported: "—", blocked: "⊘", skip: "·" };

const app = document.querySelector<HTMLDivElement>("#app")!;
let report: Report | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function shell(): void {
  app.replaceChildren(
    el("header", {},
      el("h1", {}, "seam"),
      el("p", { class: "sub" },
        "Can a key derived inside the Polkadot App sign something a PolkaVM contract accepts? ",
        "Five questions, and this is the only way to answer them.",
      ),
      el("dl", { class: "meta" },
        el("dt", {}, "product"), el("dd", {}, DOT_NAME),
        el("dt", {}, "surface"), el("dd", {}, isInsideContainerSync() ? "Polkadot App" : "browser / gateway"),
        el("dt", {}, "build"), el("dd", {}, typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev"),
      ),
    ),
    el("button", { id: "run", class: "run" }, "Run"),
    el("div", { id: "out" }),
    el("footer", {}, el("a", { href: SOURCE_URL, target: "_blank", rel: "noreferrer" }, SOURCE_URL)),
  );

  document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", start);
}

async function start(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#run")!;
  const out = document.querySelector<HTMLDivElement>("#out")!;
  button.disabled = true;
  button.textContent = "Running…";
  out.replaceChildren(el("p", { class: "note" }, "Checks run in dependency order; each is bounded so one hang cannot stall the rest."));

  const store = await openStore();
  const baseline = await store.read();

  const list = el("ol", { class: "findings" });
  out.replaceChildren(list);

  const shared: Record<string, unknown> = { baseline };
  const findings = await runAll({
    shared,
    onProgress(f, i, total) {
      button.textContent = `Running… ${i + 1}/${total}`;
      list.append(renderFinding(f));
      list.lastElementChild?.scrollIntoView({ block: "nearest" });
    },
  });

  // Record before rendering, so a first run leaves a baseline even if the
  // reader closes the app the moment it finishes.
  const observed: Partial<Baseline> = {
    entropyFingerprint: (shared.burner as { entropyFingerprint?: string } | undefined)?.entropyFingerprint,
    burnerAddress: (shared.burner as { address?: string } | undefined)?.address,
    anonymousAlias: shared.alias as string | undefined,
    productAccount0: shared.productAccount0 as string | undefined,
    userId: shared.userId as string | undefined,
  };
  const buildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
  await store.write(extend(baseline, observed, buildId));

  report = build(findings, {
    userAgent: navigator.userAgent,
    inContainer: isInsideContainerSync(),
    baselineStore: store.where,
    baselineRecordedAt: baseline?.recordedAt ?? null,
  });

  render(report, findings);
  button.disabled = false;
  button.textContent = "Run again";
}

function render(r: Report, findings: Finding[]): void {
  const out = document.querySelector<HTMLDivElement>("#out")!;
  const gates = el("section", { class: "gates" }, el("h2", {}, "Gates"));
  for (const g of Object.values(r.gates)) {
    gates.append(
      el("div", { class: `gate ${g.verdict}` },
        el("span", { class: "mark" }, g.verdict === "pass" ? "✓" : g.verdict === "fail" ? "✗" : "?"),
        el("span", { class: "q" }, g.question),
        el("span", { class: "v" }, g.verdict),
      ),
    );
  }

  const list = el("ol", { class: "findings" });
  for (const f of findings) list.append(renderFinding(f));

  const actions = el("div", { class: "actions" });
  const json = el("button", {}, "Download JSON");
  json.addEventListener("click", () => download(`seam-${stamp()}.report.json`, JSON.stringify(r, null, 2), "application/json"));
  const md = el("button", {}, "Download Markdown");
  md.addEventListener("click", () => download(`seam-${stamp()}.report.md`, toMarkdown(r), "text/markdown"));
  actions.append(json, md);

  const caveats = el("section", { class: "caveats" });
  if (r.caveats.length) {
    caveats.append(el("h2", {}, "Caveats"));
    const ul = el("ul", {});
    for (const c of r.caveats) ul.append(el("li", {}, c));
    caveats.append(ul);
  }

  out.replaceChildren(gates, actions, el("h2", {}, "Findings"), list, caveats);
}

function renderFinding(f: Finding): HTMLElement {
  const item = el("li", { class: `finding ${f.status}` });
  const head = el("div", { class: "head" },
    el("span", { class: "mark" }, MARK[f.status]),
    el("span", { class: "title" }, f.title),
    el("span", { class: "status" }, f.diagnosis ? `${f.status} · ${f.diagnosis}` : f.status),
  );
  item.append(head, el("p", { class: "detail" }, f.detail));
  if (f.data && Object.keys(f.data).length) {
    const details = el("details", {}, el("summary", {}, "evidence"));
    details.append(el("pre", {}, JSON.stringify(f.data, null, 2)));
    item.append(details);
  }
  return item;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

shell();
void PRODUCT_ID;
