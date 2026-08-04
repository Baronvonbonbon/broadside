/**
 * The shell. One button, the gate verdicts, the findings, and a way to get the
 * report off the device that the platform cannot refuse.
 *
 * Built for a phone held by someone who did not write it: the gates are the
 * headline because they are the question, the findings are underneath because
 * they are the evidence, and the raw JSON is one tap away because a report
 * nobody can check is a rumour.
 */

import { isInsideContainerSync } from "@parity/product-sdk";
import { DOT_NAME, PRODUCT_ID, SOURCE_URL } from "../product.mjs";
import { build, download, safeStringify, type Report } from "./report";
import { runAll } from "./run";
import { extend, openStore } from "./memory";
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
  // Export is available from the first check, not only at the end. Four runs
  // wedged partway and each one's evidence was unreachable because the download
  // lived behind a completed run — so the most useful data in the suite was the
  // data it refused to hand over.
  const partial: Finding[] = [];
  out.replaceChildren(exportRow(() => partial, store.where, baseline?.recordedAt ?? null), list);

  // A row for the check that is *about* to run, replaced by its result when it
  // settles. Without it the only thing on screen during a stall is a count of
  // completed checks, which names everything except the one that is stuck.
  let pending: HTMLElement | null = null;
  let ticker: number | undefined;

  const shared: Record<string, unknown> = { baseline };
  const buildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

  /**
   * Persist what has been observed so far.
   *
   * This used to run once, after the last check. Every run since has wedged
   * before reaching it, so the alias baseline was never written and
   * alias.crossSession reported "first run — baseline recorded" on every single
   * run, forever. A cross-session check whose baseline only persists on a clean
   * finish cannot answer a question about restarts on a suite that does not
   * finish.
   */
  const persist = async () => {
    await store.write(
      extend(
        baseline,
        {
          entropyFingerprint: (shared.burner as { entropyFingerprint?: string } | undefined)?.entropyFingerprint,
          burnerAddress: (shared.burner as { address?: string } | undefined)?.address,
          anonymousAlias: shared.alias as string | undefined,
          productAccount0: shared.productAccount0 as string | undefined,
          userId: shared.userId as string | undefined,
        },
        buildId,
      ),
    );
  };

  const findings = await runAll({
    shared,
    onStart(check, i, total) {
      button.textContent = `Running… ${i + 1}/${total}`;
      const status = el("span", { class: "status" }, `running · ${check.id}`);
      pending = el("li", { class: "finding running" },
        el("div", { class: "head" },
          el("span", { class: "mark" }, "⋯"),
          el("span", { class: "title" }, check.title),
          status,
        ),
      );
      list.append(pending);
      pending.scrollIntoView({ block: "nearest" });

      // A count that stands still and a count that climbs are different
      // situations. Without the elapsed seconds beside the budget, a check
      // waiting out a 12 s transport timeout looks exactly like a hang.
      const t0 = performance.now();
      const budget = Math.round((check.timeoutMs ?? 30_000) / 1000);
      clearInterval(ticker);
      ticker = setInterval(() => {
        status.textContent = `running · ${check.id} · ${Math.round((performance.now() - t0) / 1000)}s / ${budget}s`;
      }, 500) as unknown as number;
    },
    onProgress(f) {
      clearInterval(ticker);
      partial.push(f);
      // Fire and forget: a failed write must not stall the run, and the next
      // check's completion will try again anyway.
      void persist().catch(() => {});
      const row = renderFinding(f);
      if (pending) pending.replaceWith(row);
      else list.append(row);
      pending = null;
      row.scrollIntoView({ block: "nearest" });
    },
  });
  clearInterval(ticker);

  await persist();

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

  // The same export row as mid-run, so there is one way to get data out and it
  // is the one that has been exercised on every wedged run.
  const actions = exportRow(() => findings, r.surface.baselineStore, r.surface.baselineRecordedAt);

  const caveats = el("section", { class: "caveats" });
  if (r.caveats.length) {
    caveats.append(el("h2", {}, "Caveats"));
    const ul = el("ul", {});
    for (const c of r.caveats) ul.append(el("li", {}, c));
    caveats.append(ul);
  }

  out.replaceChildren(gates, actions, el("h2", {}, "Findings"), list, caveats);
}

/**
 * Getting the report off the device.
 *
 * Download is listed last on purpose: a Blob URL driven by a synthetic anchor
 * click **does not work in the Polkadot App's Android WebView** — there is no
 * download manager wired to it, so the tap silently does nothing. That is not a
 * detail to work around quietly. It means a suite whose only export was a
 * download had, for six runs, no way to hand over the one thing it exists to
 * produce.
 *
 * So the reliable path is a textarea: selectable, scrollable, and impossible
 * for a platform to refuse. Copy-to-clipboard sits in front of it as the
 * convenience, and falls back to selecting the text when the clipboard API is
 * unavailable or blocked — which it often is outside a secure context.
 *
 * Takes a getter rather than an array so the same row serves a run in progress
 * and a finished one: the click reads the buffer at the moment it happens,
 * which is what makes a *wedged* run exportable.
 */
function exportRow(get: () => Finding[], baselineStore = "unknown", baselineRecordedAt: string | null = null): HTMLElement {
  const surface = {
    userAgent: navigator.userAgent,
    inContainer: isInsideContainerSync(),
    baselineStore,
    baselineRecordedAt,
  };
  const text = () => safeStringify(report ?? build(get(), surface));

  const wrap = el("section", { class: "export" });
  const actions = el("div", { class: "actions" });

  const box = el("textarea", {
    class: "report-json",
    readonly: "readonly",
    spellcheck: "false",
    "aria-label": "Report JSON",
  }) as HTMLTextAreaElement;
  box.hidden = true;

  const note = el("span", { class: "copy-note" }, "");

  const copy = el("button", {}, "Copy JSON");
  copy.addEventListener("click", async () => {
    const payload = text();
    box.value = payload;
    try {
      await navigator.clipboard.writeText(payload);
      note.textContent = `copied ${payload.length.toLocaleString()} chars`;
    } catch {
      // Blocked or absent. Reveal and select instead — the user can still copy
      // with the OS control, which is the outcome that actually matters.
      box.hidden = false;
      box.focus();
      box.select();
      note.textContent = "clipboard blocked — text selected, copy with the OS control";
    }
  });

  const show = el("button", {}, "Show JSON");
  show.addEventListener("click", () => {
    box.value = text();
    box.hidden = !box.hidden;
    show.textContent = box.hidden ? "Show JSON" : "Hide JSON";
    if (!box.hidden) box.scrollIntoView({ block: "nearest" });
  });

  const dl = el("button", { class: "secondary" }, "Download");
  dl.addEventListener("click", () => {
    download(`seam-${stamp()}.report.json`, text(), "application/json");
    note.textContent = "if nothing happened, the WebView blocked it — use Copy or Show";
  });

  actions.append(copy, show, dl);
  wrap.append(actions, note, box);
  return wrap;
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
    details.append(el("pre", {}, safeStringify(f.data)));
    item.append(details);
  }
  return item;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

shell();
void PRODUCT_ID;
