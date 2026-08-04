/**
 * Cross-session memory, via the host's own per-product store.
 *
 * This is what makes the determinism and stability answers worth anything.
 * Calling `deriveEntropy` twice in one session and getting the same bytes is
 * weak evidence — a host that cached the first result would look identical. The
 * claim that actually matters is that the value survives the app being closed,
 * the WebView being torn down, and the device being rebooted, and the only way
 * to test that is to write the first answer down and compare on a later run.
 *
 * So a single run of this probe cannot answer two of the five gates. It says so
 * rather than guessing: the first run records, the second run compares, and
 * until then those checks report `skip` with the reason.
 *
 * Falls back to `window.localStorage` outside a container so the probe stays
 * useful in a plain browser tab, where it is measuring the web platform rather
 * than the host.
 */

import { getHostLocalStorage } from "@parity/product-sdk-host";

const KEY = "broadside.seam.baseline.v1";

export interface Baseline {
  /** ISO timestamp of the run that recorded it. */
  recordedAt: string;
  /** Build id of that run — a difference here explains a difference below. */
  buildId: string;
  entropyFingerprint?: string;
  burnerAddress?: string;
  anonymousAlias?: string;
  productAccount0?: string;
  userId?: string;
}

export interface Store {
  where: "host" | "web" | "none";
  read(): Promise<Baseline | null>;
  write(b: Baseline): Promise<void>;
}

export async function openStore(): Promise<Store> {
  try {
    const host = await getHostLocalStorage();
    if (host) {
      return {
        where: "host",
        async read() {
          const v = await host.readJSON(KEY);
          return (v as Baseline | null) ?? null;
        },
        async write(b) {
          await host.writeJSON(KEY, b);
        },
      };
    }
  } catch {
    // Falling through is correct: an unavailable host store is not an error
    // here, it just means the comparison runs against the web one instead and
    // the report says so.
  }

  try {
    if (typeof localStorage !== "undefined") {
      return {
        where: "web",
        async read() {
          const raw = localStorage.getItem(KEY);
          return raw ? (JSON.parse(raw) as Baseline) : null;
        },
        async write(b) {
          localStorage.setItem(KEY, JSON.stringify(b));
        },
      };
    }
  } catch {
    // Private-mode Safari and some embedder policies throw on access rather
    // than returning null.
  }

  return {
    where: "none",
    async read() {
      return null;
    },
    async write() {},
  };
}

/**
 * Merge this run's observations into the baseline without overwriting what is
 * already recorded — the first observation is the one with evidential value,
 * and silently replacing it would make every run agree with itself.
 */
export function extend(prior: Baseline | null, observed: Partial<Baseline>, buildId: string): Baseline {
  const base: Baseline = prior ?? { recordedAt: new Date().toISOString(), buildId };
  const writable = base as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(observed)) {
    if (v !== undefined && writable[k] === undefined) writable[k] = v;
  }
  return base;
}
