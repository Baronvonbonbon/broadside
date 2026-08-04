/**
 * The runner. Small on purpose — sixteen sequential checks do not need sonde's
 * machinery, but they do need its one non-negotiable property: **a check cannot
 * wedge the run.**
 *
 * Every check is bounded and every throw is classified. The honest limit is the
 * same one sonde documents: `Promise.race` does not cancel the losing promise,
 * so a hung host call leaves a dangling promise for the life of the page. There
 * is no way to kill an in-flight platform call from script. What is guaranteed
 * is that the run moves on and the report says the call never settled — which
 * is itself the most interesting result a probe can produce.
 */

import { CHECKS } from "./checks";
import type { Check, Ctx, Finding } from "./types";

export { CHECKS };

const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunOptions {
  /**
   * Fired before a check runs.
   *
   * Run 3 stalled and the UI could only say "Running… 14/17" — a number that
   * counts *completed* checks, so the one actually in flight was the one thing
   * on screen that could not be named. A stall nobody can attribute is a stall
   * nobody can fix.
   */
  onStart?(check: Check, index: number, total: number): void;
  onProgress?(finding: Finding, index: number, total: number): void;
  shared?: Record<string, unknown>;
}

export async function runAll(opts: RunOptions = {}): Promise<Finding[]> {
  const found = new Map<string, Finding>();
  const shared = opts.shared ?? {};
  const findings: Finding[] = [];

  for (const [i, check] of CHECKS.entries()) {
    opts.onStart?.(check, i, CHECKS.length);
    const finding = await runOne(check, { found, shared, signal: new AbortController().signal, mark: () => {} });
    found.set(finding.id, finding);
    findings.push(finding);
    try {
      opts.onProgress?.(finding, i, CHECKS.length);
    } catch (e) {
      // The runner's whole promise is that no single check can wedge the suite.
      // That promise was void while a throw in the progress callback could
      // unwind the loop — and one did, for six runs, disguised as a hang.
      // Reporting a result is not allowed to be the thing that stops the run.
      finding.data = { ...(finding.data ?? {}), renderError: String(e) };
    }
  }

  // Best effort: leaving a host connection open past the run is exactly the
  // kind of leak that makes a second run disagree with the first.
  const rpc = shared.hostRpc as { close?: () => void } | undefined;
  try {
    rpc?.close?.();
  } catch {
    // A transport the host already tore down is not a failure to report.
  }

  return findings;
}

async function runOne(check: Check, ctx: Ctx): Promise<Finding> {
  const base = { id: check.id, title: check.title, why: check.why };

  // An unmet dependency is `skip`, never `fail`. The distinction is the whole
  // reason the status vocabulary is wider than pass/fail: "we could not ask"
  // and "the answer is no" are different findings, and a reader who cannot tell
  // them apart will read a cascade of skips as a cascade of bugs.
  const unmet = (check.needs ?? []).filter((id) => {
    const dep = ctx.found.get(id);
    return !dep || dep.status !== "pass";
  });
  if (unmet.length) {
    const reasons = unmet.map((id) => `${id} → ${ctx.found.get(id)?.status ?? "never ran"}`);
    return {
      ...base,
      status: "skip",
      detail: `Precondition unmet: ${reasons.join(", ")}.`,
      data: { unmet: reasons },
      ms: 0,
    };
  }

  const controller = new AbortController();
  const budget = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = performance.now();

  const trace: string[] = [];
  const mark = (label: string) => trace.push(`+${Math.round(performance.now() - t0)}ms ${label}`);

  const timeout = new Promise<Finding>((resolve) => {
    setTimeout(() => {
      controller.abort();
      resolve({
        ...base,
        status: "fail",
        detail:
          `Never settled within ${budget} ms.` +
          (trace.length
            ? ` Last breadcrumb: ${trace[trace.length - 1]} — whatever follows it is what did not return.`
            : " No breadcrumb was recorded, so it stalled before the first one, or the event loop is blocked and this timer only fired late."),
        diagnosis: "never-settled",
        data: { trace, budgetMs: budget },
        ms: budget,
      });
    }, budget);
  });

  const work = (async (): Promise<Finding> => {
    try {
      const outcome = await check.run({ ...ctx, signal: controller.signal, mark });
      return {
        ...base,
        ...outcome,
        // Carried on success too: a check that passes in 9 s and one that
        // passes in 90 ms are different facts about the platform.
        data: trace.length ? { ...(outcome.data ?? {}), trace } : outcome.data,
        ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      return {
        ...base,
        status: "fail",
        detail: `Threw: ${e instanceof Error ? e.message : String(e)}`,
        diagnosis: "threw",
        data: { trace },
        ms: Math.round(performance.now() - t0),
      };
    }
  })();

  return Promise.race([work, timeout]);
}
