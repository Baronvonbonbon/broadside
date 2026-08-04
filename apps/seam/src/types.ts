/**
 * The vocabulary a finding is written in.
 *
 * `pass | fail | skip` is too coarse to be worth collecting. The interesting
 * question is never "did it work" but "whose problem is it", and that is the
 * difference between an API that is absent, one that is present and refused,
 * and one that is present, allowed, and wrong. Only the third is a bug in
 * someone's code, and a report that cannot say which it saw is a rumour.
 *
 * Borrowed from sonde, which arrived at the same vocabulary across 132 probes.
 */
export type Status =
  /** Invoked, returned something correct. */
  | "pass"
  /** Genuinely absent. A true negative, nobody's bug. */
  | "unsupported"
  /** Present, denied by policy or permission. */
  | "blocked"
  /** Present and allowed, but errored or returned something wrong. */
  | "fail"
  /** Precondition unmet — a dependency did not produce what this needed. */
  | "skip";

/**
 * A stable slug for *why*, so results survive being compared across devices.
 * Prose does not diff; a slug does.
 */
export type Diagnosis =
  | "not-in-container"
  | "not-implemented"
  | "host-returned-null"
  | "host-call-failed"
  | "not-deterministic"
  | "fresh-per-call"
  | "keys-collide"
  | "no-address-configured"
  | "chain-not-supported"
  | "method-not-found"
  | "network-blocked"
  | "recovery-mismatch"
  | "unfunded"
  | "threw";

export interface Finding {
  id: string;
  title: string;
  /** What turns on the answer. Carried into the report so a reader can judge it. */
  why: string;
  status: Status;
  detail: string;
  diagnosis?: Diagnosis;
  /** Machine-diffable evidence. Keep it primitives — this gets compared across runs. */
  data?: Record<string, unknown>;
  ms?: number;
}

/** The five questions Phase 1 exists to answer. Each maps to one or more findings. */
export const GATES = {
  entropyDeterministic: "deriveEntropy is deterministic in a published bundle",
  aliasStable: "getAnonymousAlias is stable per product",
  accountsDistinct: "getProductAccount yields distinct keys per index",
  chainReachable: "the host provider reaches the chain and reads correctly",
  recoverAccepted: "a burner-signed EIP-712 payload survives on-chain ecrecover",
} as const;

export type GateId = keyof typeof GATES;

export interface Check {
  id: string;
  title: string;
  why: string;
  /** Which gate(s) this contributes to. A gate passes only if all of its checks do. */
  gates: GateId[];
  /** Findings this depends on. An unmet dependency yields `skip`, never `fail`. */
  needs?: string[];
  timeoutMs?: number;
  run(ctx: Ctx): Promise<Omit<Finding, "id" | "title" | "why" | "ms">>;
}

export interface Ctx {
  /** Results so far, by id — how a check reads what an earlier one established. */
  found: Map<string, Finding>;
  /** Values passed between checks. Untyped on purpose; this is a probe, not a framework. */
  shared: Record<string, unknown>;
  signal: AbortSignal;
}

export const ok = (detail: string, data?: Finding["data"]): Omit<Finding, "id" | "title" | "why" | "ms"> => ({
  status: "pass",
  detail,
  data,
});

export const bad = (
  detail: string,
  diagnosis: Diagnosis,
  data?: Finding["data"],
): Omit<Finding, "id" | "title" | "why" | "ms"> => ({ status: "fail", detail, diagnosis, data });

export const absent = (
  detail: string,
  diagnosis: Diagnosis = "not-implemented",
  data?: Finding["data"],
): Omit<Finding, "id" | "title" | "why" | "ms"> => ({ status: "unsupported", detail, diagnosis, data });

export const skipped = (
  detail: string,
  diagnosis?: Diagnosis,
  data?: Finding["data"],
): Omit<Finding, "id" | "title" | "why" | "ms"> => ({ status: "skip", detail, diagnosis, data });
