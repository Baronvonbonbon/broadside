/**
 * The sixteen questions, in dependency order.
 *
 * Each maps to one or more of the five Phase 1 gates. A gate passes only if
 * every check feeding it passes, and a check whose precondition was not met
 * reports `skip` rather than `fail` — "we could not ask" and "the answer is no"
 * are different results and collapsing them is how a report starts lying.
 */

import { createApp, isInsideContainerSync } from "@parity/product-sdk";
import { getAccountsProvider, getTruApi, isChainSupported, toHex } from "@parity/product-sdk-host";
import type { App } from "@parity/product-sdk";
import { Wallet } from "ethers";

import {
  CLOUD_ENV,
  ENTROPY_LABEL,
  ENTROPY_LABEL_ALT,
  DOT_NAME,
  ETH_RPC_URL,
  PRODUCT_ID,
} from "../product.mjs";
import { deriveBurner, hostEntropy, keyFromEntropy } from "./burner";
import { HostRpc, ethCall, ethChainId, type Hex } from "./chain";
import { ASSET_HUBS, KNOWN_CHAINS } from "./chains";
import type { Baseline } from "./memory";
import {
  CONTRACT_ADDRESS,
  CONTRACT_CHAIN_ID,
  CONTRACT_TARGET,
  decodeResult,
  encodeChainId,
  encodeRecover,
  freshSeam,
  signSeam,
} from "./seam";
import { absent, bad, ok, skipped, type Check, type Ctx } from "./types";

/** neverthrow → the plain tagged shape. AccountsProvider uses it; the top-level wrappers do not. */
async function nt<T, E>(r: {
  match<A>(onOk: (v: T) => A, onErr: (e: E) => A): Promise<A>;
}): Promise<{ ok: true; value: T } | { ok: false; error: E }> {
  return r.match<{ ok: true; value: T } | { ok: false; error: E }>(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

const msg = (e: unknown): string =>
  e instanceof Error ? e.message : (JSON.stringify(e) ?? String(e)).slice(0, 200);

const short = (s: string, head = 10, tail = 6): string =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

// ── host presence ───────────────────────────────────────────────────────────

const container: Check = {
  id: "host.container",
  title: "Running inside the Polkadot App",
  why: "Everything else depends on it. Outside a container the host API is simply absent, and every check below should read skip, not fail.",
  gates: [],
  async run() {
    const inside = isInsideContainerSync();
    const data = { inside, userAgent: navigator.userAgent };
    return inside
      ? ok("Inside the host container.", data)
      : absent(
          "Not in a host container — this is a plain browser tab or the gateway iframe. The host checks below cannot run, which is a property of where this was opened, not a defect.",
          "not-in-container",
          data,
        );
  },
};

const handshake: Check = {
  id: "host.handshake",
  title: "TrUApi handshake",
  why: "The transport greeting every other host call sits on. One failure here explains all of them at once.",
  gates: [],
  needs: ["host.container"],
  timeoutMs: 30_000,
  async run(ctx) {
    const api = await getTruApi();
    if (!api) return absent("getTruApi() returned null — no host transport.", "host-returned-null");
    const r = await nt(api.system.handshake());
    if (!r.ok) return bad(`Handshake rejected: ${msg(r.error)}`, "host-call-failed");
    ctx.shared.truapi = api;
    return ok("Handshake completed.", {
      namespaces: Object.keys(api).filter((k) => !k.startsWith("_")),
    });
  },
};

const app: Check = {
  id: "host.createApp",
  title: "createApp",
  why: "The wallet surface hangs off the App object, and a cloud-storage environment that disagrees with the publish environment surfaces here rather than three checks later.",
  gates: [],
  needs: ["host.container"],
  timeoutMs: 60_000,
  async run(ctx) {
    try {
      const a = await createApp({ name: PRODUCT_ID, cloudStorage: { environment: CLOUD_ENV } });
      ctx.shared.app = a;
      return ok("App constructed on the configured environment.", {
        productId: PRODUCT_ID,
        env: CLOUD_ENV,
        cloudStorage: Boolean(a.cloudStorage),
      });
    } catch (e) {
      return bad(`createApp threw: ${msg(e)}`, "host-call-failed", { productId: PRODUCT_ID, env: CLOUD_ENV });
    }
  },
};

// ── gate 1: entropy determinism ─────────────────────────────────────────────

const entropyDeterminism: Check = {
  id: "entropy.determinism",
  title: "deriveEntropy — same input, same bytes",
  why: "The burner is regenerated from this rather than stored, so if it is not deterministic there is a key to back up and the whole no-seed design collapses.",
  gates: ["entropyDeterministic"],
  needs: ["host.container"],
  timeoutMs: 30_000,
  async run(ctx) {
    let first: Uint8Array;
    let second: Uint8Array;
    let control: Uint8Array;
    try {
      first = await hostEntropy(ENTROPY_LABEL);
      second = await hostEntropy(ENTROPY_LABEL);
      control = await hostEntropy(ENTROPY_LABEL_ALT);
    } catch (e) {
      return bad(msg(e), "host-call-failed");
    }

    const a = toHex(first);
    const b = toHex(second);
    const c = toHex(control);
    const data = { bytes: first.length, sameInputMatches: a === b, differentInputDiffers: a !== c };

    if (a !== b) {
      return bad(
        "Not deterministic — the same input gave different entropy on two calls. Any key derived from it would need a backup, and regenerating it would produce a different address every time.",
        "not-deterministic",
        data,
      );
    }
    if (a === c) {
      // Worse than non-determinism: it looks stable while ignoring its
      // argument, so every domain separator collapses to one key.
      return bad(
        "Deterministic, but a different input produced the SAME entropy. The label is being ignored, so domain separation does nothing and every derived key is the same key.",
        "keys-collide",
        data,
      );
    }
    ctx.shared.entropy = first;
    return ok("Deterministic in-session, and the label is honoured.", data);
  },
};

const burner: Check = {
  id: "burner.derive",
  title: "Derive the app-local secp256k1 burner",
  why: "The host signs sr25519 and cannot produce an ecrecover-able signature, and AutoSigning is unavailable on both mobile wallets, so this key is the only way to sign per impression without a tap.",
  gates: ["entropyDeterministic"],
  needs: ["entropy.determinism"],
  timeoutMs: 30_000,
  async run(ctx) {
    try {
      const b = await deriveBurner(ENTROPY_LABEL);
      ctx.shared.burner = b;
      // Derived twice, from independently fetched entropy, because the address
      // is what actually has to be reproducible — not the bytes behind it.
      const again = keyFromEntropy(await hostEntropy(ENTROPY_LABEL));
      const stable = again.address === b.address;
      const data = { address: b.address, entropyFingerprint: b.entropyFingerprint, rederivedMatches: stable };
      return stable
        ? ok(`Burner derived: ${b.address}`, data)
        : bad("Re-deriving produced a different address.", "not-deterministic", data);
    } catch (e) {
      return bad(msg(e), "host-call-failed");
    }
  },
};

const entropyCrossSession: Check = {
  id: "entropy.crossSession",
  title: "Determinism across sessions",
  why: "Two calls in one session prove nothing a cache could not fake. Surviving app restart is the claim that matters, and only a recorded baseline can test it.",
  gates: ["entropyDeterministic"],
  needs: ["burner.derive"],
  async run(ctx) {
    const baseline = ctx.shared.baseline as Baseline | null;
    const b = ctx.shared.burner as { address: string; entropyFingerprint: string };
    if (!baseline?.burnerAddress) {
      return skipped(
        "First run — baseline recorded. Close the app completely, reopen it, and run again: this check is the one that answers the gate.",
        undefined,
        { recorded: b.address },
      );
    }
    const matches = baseline.burnerAddress === b.address;
    const data = {
      baselineAddress: baseline.burnerAddress,
      thisRun: b.address,
      matches,
      baselineRecordedAt: baseline.recordedAt,
      baselineBuildId: baseline.buildId,
    };
    return matches
      ? ok(`Same burner as the run on ${baseline.recordedAt}. Determinism survives a restart.`, data)
      : bad(
          "The burner changed between sessions. Entropy is per-session, not per-product, so earnings would land on an address the viewer can never reach again.",
          "not-deterministic",
          data,
        );
  },
};

// ── gate 2: alias stability ─────────────────────────────────────────────────

const aliasInSession: Check = {
  id: "alias.deprecatedWalletCall",
  title: "app.wallet.getAnonymousAlias() — the deprecated path",
  why: "Kept as a data point, not a gate. Runs 1–4 read its null return as 'the Ring VRF alias does not exist', which was wrong — the alias lives on AccountsProvider. Recording both makes the deprecation visible instead of inferring an absence from it.",
  gates: [],
  needs: ["host.createApp"],
  timeoutMs: 30_000,
  async run(ctx) {
    const a = ctx.shared.app as App | undefined;
    if (!a) return skipped("No App — createApp did not produce one.");
    let first: string | null;
    let second: string | null;
    try {
      first = a.wallet.getAnonymousAlias();
      second = a.wallet.getAnonymousAlias();
    } catch (e) {
      return bad(`getAnonymousAlias threw: ${msg(e)}`, "threw");
    }
    if (first == null) {
      return absent(
        "Returns null. Not evidence that the alias is unavailable — see alias.productAccountAlias, which is the supported surface.",
        "host-returned-null",
      );
    }
    const stable = first === second;
    const data = { alias: first, stableAcrossCalls: stable };
    return stable
      ? ok("Stable across calls within the session.", data)
      : bad(
          "Fresh on every call. Unlinkable, but it cannot serve as a pseudonym the product remembers — a viewer could not be recognised as returning.",
          "fresh-per-call",
          data,
        );
  },
};

/**
 * The alias, asked for correctly.
 *
 * Runs 1–4 concluded "the Ring VRF alias does not exist" from
 * `app.wallet.getAnonymousAlias()` returning null. That was the wrong surface.
 * `AccountsProvider.getProductAccountAlias(context, ringLocation)` is the real
 * API — on the same object this probe already uses for `getProductAccount` and
 * `getUserId`, and present in the installed SDK all along.
 *
 * It needs a ring to derive against, and the host does not publish one, so the
 * candidates are swept and every error reported verbatim. The error type earns
 * that: `RingNotFound` means the location is wrong, `NotMember` means the
 * location is *right* and this user is not enrolled in the ring — which is the
 * personhood question, and a completely different answer.
 */
/**
 * `ContextualAlias.alias` arrives as a Uint8Array — the SDK decodes truapi's
 * HexString fields to bytes. Both call sites go through here so neither can
 * compare a hex string against raw bytes and conclude they differ.
 */
function aliasHex(value: unknown): string {
  const a = (value as { alias?: unknown } | null)?.alias;
  if (typeof a === "string") return a.toLowerCase();
  if (a instanceof Uint8Array) return toHex(a).toLowerCase();
  // Structured-cloned bytes cross the host bridge as a plain index-keyed object.
  if (a && typeof a === "object") {
    const keys = Object.keys(a).filter((k) => /^\d+$/.test(k));
    if (keys.length) {
      return toHex(Uint8Array.from(keys.sort((x, y) => Number(x) - Number(y)).map((k) => (a as Record<string, number>)[k]))).toLowerCase();
    }
  }
  return String(a ?? "");
}

const productAlias: Check = {
  id: "alias.productAccountAlias",
  title: "Ring VRF alias — getProductAccountAlias",
  why: "This is the viewer pseudonym the plan was built on. Whether it exists, and whether it is stable per product, decides if unlinkability is a platform guarantee or purely Broadside's own construction.",
  gates: ["aliasStable"],
  needs: ["host.handshake"],
  timeoutMs: 60_000,
  async run(ctx) {
    const provider = await getAccountsProvider();
    if (!provider) return absent("getAccountsProvider() returned null.", "host-returned-null");
    if (typeof provider.getProductAccountAlias !== "function") {
      return absent("This SDK build has no getProductAccountAlias.", "not-implemented");
    }

    // The doc comment says productId is the dotNS identifier "e.g. my-product.dot",
    // but getProductAccount accepts the bare label and works. Try both rather
    // than pick — a wrong productId and a wrong ring fail differently and the
    // error text is what tells them apart.
    const ringChains = KNOWN_CHAINS.filter((c) => c.kind === "individuality" || c.descriptor === "devnet-asset-hub");
    const attempts: Record<string, string> = {};
    let alias: string | null = null;
    let winner = "";

    outer: for (const productId of [DOT_NAME, PRODUCT_ID]) {
      for (const chain of ringChains) {
        const label = `${productId} @ ${chain.descriptor}`;
        const r = await nt(
          provider.getProductAccountAlias(
            { productId, suffix: { tag: "Left", value: 0 } },
            { chainId: chain.genesis, junctions: [] },
          ),
        );
        if (r.ok) {
          alias = aliasHex(r.value);
          attempts[label] = `ok — alias ${alias.slice(0, 18)}…`;
          winner = label;
          break outer;
        }
        attempts[label] = msg(r.error);
      }
    }

    const data = { attempts, tried: Object.keys(attempts).length };
    if (!alias) {
      const text = Object.values(attempts).join(" | ");
      // NotMember is not a failure of the API — it is an answer about the user.
      if (/NotMember/i.test(text)) {
        return absent(
          "The ring exists but this user is not a member. The alias is gated on ring enrolment — which is the personhood question, not an API gap.",
          "not-implemented",
          data,
        );
      }
      return absent(
        "No candidate ring produced an alias. The host does not publish a ring location, so this swept the individuality chains and the Asset Hub with an empty junction path; a correct location would need documenting rather than guessing.",
        "not-implemented",
        data,
      );
    }

    ctx.shared.alias = alias;
    // Called twice: within-session stability is the cheap half of the question.
    const second = await nt(
      provider.getProductAccountAlias(
        { productId: winner.startsWith(DOT_NAME) ? DOT_NAME : PRODUCT_ID, suffix: { tag: "Left", value: 0 } },
        { chainId: ringChains.find((c) => winner.endsWith(c.descriptor))!.genesis, junctions: [] },
      ),
    );
    // Normalised through the same helper as the first call. 1.4.0 hexed one
    // side and not the other, compared a string to a Uint8Array, and reported a
    // stable alias as "fresh on every call" — a false negative on the single
    // question the check exists to answer.
    const secondAlias = second.ok ? aliasHex(second.value) : null;
    const stable = secondAlias === alias;

    return stable
      ? ok(`Alias derived and stable across calls, via ${winner}.`, { ...data, alias, stableAcrossCalls: true })
      : bad(
          "Fresh on every call. Unlinkable, but it cannot serve as a pseudonym the product remembers.",
          "fresh-per-call",
          { ...data, first: alias, second: secondAlias },
        );
  },
};

const aliasCrossSession: Check = {
  id: "alias.crossSession",
  title: "Alias stability across sessions",
  why: "Same reasoning as the entropy baseline: within one session a cached value and a stable one are indistinguishable.",
  gates: ["aliasStable"],
  needs: ["alias.productAccountAlias"],
  async run(ctx) {
    const baseline = ctx.shared.baseline as Baseline | null;
    const alias = ctx.shared.alias as string | undefined;
    if (!alias) return skipped("No alias observed this run.");
    if (!baseline?.anonymousAlias) {
      return skipped("First run — baseline recorded. Reopen the app and run again.", undefined, { recorded: alias });
    }
    const matches = baseline.anonymousAlias === alias;
    return matches
      ? ok(`Same alias as ${baseline.recordedAt}. Usable as a per-product pseudonym.`, { matches, alias })
      : bad(
          "The alias changed between sessions. It is per-session, not per-product, so it cannot anchor a viewer's identity across visits.",
          "fresh-per-call",
          { baselineAlias: baseline.anonymousAlias, thisRun: alias, matches },
        );
  },
};

// ── gate 3: product accounts ────────────────────────────────────────────────

const productAccounts: Check = {
  id: "account.productAccounts",
  title: "Per-index product account derivation",
  why: "Distinct keys per index is what makes a per-session payout address possible without a seed backup. If indices collide, unlinkability is not achievable at this layer at all.",
  gates: ["accountsDistinct"],
  needs: ["host.handshake"],
  timeoutMs: 45_000,
  async run(ctx) {
    const provider = await getAccountsProvider();
    if (!provider) return absent("getAccountsProvider() returned null.", "host-returned-null");

    const indices = [0, 1, 2, 7];
    const keys: Record<string, string> = {};
    const errors: Record<string, string> = {};
    for (const index of indices) {
      const r = await nt(provider.getProductAccount(PRODUCT_ID, index));
      if (!r.ok) {
        errors[String(index)] = msg(r.error);
        continue;
      }
      keys[String(index)] = toHex((r.value as { publicKey: Uint8Array }).publicKey);
    }

    const values = Object.values(keys);
    if (!values.length) return bad("No derivation index produced an account.", "host-call-failed", { errors });

    const distinct = new Set(values).size === values.length;
    const data = { indices, keys, errors, distinct };
    if (values[0]) ctx.shared.productAccount0 = keys["0"];
    return distinct
      ? ok(`${values.length} distinct key(s) across indices.`, data)
      : bad(
          "Different indices produced the same key. Per-session payout accounts would be linkable, which defeats the point of having them.",
          "keys-collide",
          data,
        );
  },
};

const userId: Check = {
  id: "account.userId",
  title: "getUserId — and what it costs to use",
  why: "Run 1 returned a human-readable global username. That is not a per-product pseudonym: any Product can read the same handle, so using it anywhere would link a viewer across every publisher at once. It is reported as a hazard, not a feature.",
  gates: [],
  needs: ["host.handshake"],
  timeoutMs: 30_000,
  async run(ctx) {
    const provider = await getAccountsProvider();
    if (!provider) return absent("getAccountsProvider() returned null.", "host-returned-null");
    const r = await nt(provider.getUserId());
    if (!r.ok) return absent(`getUserId errored: ${msg(r.error)}`, "not-implemented");

    const value = r.value as Record<string, unknown> | null;
    const username = typeof value?.primaryUsername === "string" ? value.primaryUsername : null;
    ctx.shared.userId = JSON.stringify(value);

    // Deliberately does NOT record the username itself. This report is meant to
    // be shared, and publishing the reporter's global handle beside their burner
    // address would hand any reader the exact correlation the design exists to
    // prevent — in a document arguing that the correlation is hard.
    const data = {
      fields: value ? Object.keys(value) : [],
      hasGlobalUsername: Boolean(username),
      usernameLength: username?.length ?? 0,
    };

    if (!username) {
      return ok("Returned an id with no global username field.", data);
    }
    return {
      status: "pass" as const,
      detail:
        "A stable, human-readable, GLOBAL username is readable by any Product. The platform therefore does not provide cross-product unlinkability on its own — Broadside's comes from the per-product derived burner, and only holds as long as this value never leaves the device. It is exactly what a global rate limit would need, which is the trade: using it buys Sybil resistance and spends the privacy claim.",
      data,
    };
  },
};

// ── gate 4: can the host reach a contract ───────────────────────────────────

const hostSupports: Check = {
  id: "chain.hostSupports",
  title: "Which chains does this host build actually carry?",
  why: "Run 1 asked for the only Asset Hub truapi names and got 'not supported'. The descriptors package ships eight chains and a host build carries a subset — which one decides where Broadside's contracts have to live.",
  gates: [],
  needs: ["host.handshake"],
  timeoutMs: 60_000,
  async run(ctx) {
    const supported: string[] = [];
    const unsupported: string[] = [];
    const errors: Record<string, string> = {};

    for (const chain of KNOWN_CHAINS) {
      const r = await isChainSupported(chain.genesis);
      if (!r.ok) {
        errors[chain.descriptor] = msg(r.error);
        continue;
      }
      (r.value ? supported : unsupported).push(chain.descriptor);
    }

    // Only an Asset Hub can hold a pallet-revive contract, so that is the
    // subset that decides anything.
    const hubs = ASSET_HUBS.filter((c) => supported.includes(c.descriptor));
    ctx.shared.supportedHubs = hubs;
    const data = { supported, unsupported, errors, supportedAssetHubs: hubs.map((h) => h.descriptor) };

    if (!supported.length) {
      return bad(
        "The host reports no known chain as supported. Either isChainSupported is not implemented on this build, or the descriptor genesis hashes have drifted.",
        "chain-not-supported",
        data,
      );
    }
    if (!hubs.length) {
      return bad(
        `Carries ${supported.join(", ")} but no Asset Hub. A pallet-revive contract cannot be reached through this host at all.`,
        "chain-not-supported",
        data,
      );
    }
    return ok(`Carries ${supported.length} of ${KNOWN_CHAINS.length}; usable Asset Hub: ${hubs.map((h) => h.name).join(", ")}.`, data);
  },
};

const hostTransport: Check = {
  id: "chain.hostTransport",
  title: "Host provider — what does the transport actually speak?",
  why: "getHostProvider returns polkadot-api's JsonRpcProvider, a Substrate transport. Whether it also answers eth_* decides whether the widget can talk to pallet-revive directly or needs a translation layer.",
  gates: ["hostRouted"],
  needs: ["chain.hostSupports"],
  timeoutMs: 45_000,
  async run(ctx) {
    // Ask for an Asset Hub the host said it carries, rather than the one this
    // probe would prefer. Run 1 did the opposite and learned nothing about the
    // transport, only about the chain list.
    const hubs = (ctx.shared.supportedHubs ?? []) as typeof ASSET_HUBS;
    const target = hubs[0];
    if (!target) return skipped("No supported Asset Hub to open a provider against.", "chain-not-supported");

    let rpc: HostRpc | null;
    try {
      rpc = await HostRpc.open(target.genesis as Hex);
    } catch (e) {
      return bad(`getHostProvider threw: ${msg(e)}`, "chain-not-supported", { chain: target.name, genesis: target.genesis });
    }
    if (!rpc) return absent("getHostProvider() returned null for this chain.", "host-returned-null", { chain: target.name });
    ctx.shared.hostChain = target;

    ctx.shared.hostRpc = rpc;

    // One call enumerates the whole surface, which beats guessing method names
    // one at a time and reading "method not found" as if it meant something.
    const methods = await rpc.call("rpc_methods");
    const genesis = await rpc.call("chainSpec_v1_genesisHash");
    const chainId = await rpc.call("eth_chainId");

    const list = Array.isArray((methods.result as { methods?: string[] })?.methods)
      ? ((methods.result as { methods: string[] }).methods as string[])
      : Array.isArray(methods.result)
        ? (methods.result as string[])
        : [];
    const eth = list.filter((m) => m.startsWith("eth_"));
    const revive = list.filter((m) => /revive/i.test(m));

    const data = {
      chain: target.name,
      genesisAsked: target.genesis,
      genesisReported: genesis.ok ? String(genesis.result) : null,
      genesisMatches: genesis.ok && String(genesis.result).toLowerCase() === target.genesis.toLowerCase(),
      methodCount: list.length,
      ethMethods: eth,
      reviveMethods: revive,
      ethChainId: chainId.ok ? String(chainId.result) : null,
      ethChainIdError: chainId.ok ? null : (chainId.error?.message ?? null),
      msRoundTrip: genesis.ms,
    };

    if (!genesis.ok && !methods.ok) {
      return bad(
        `The transport opened but answered nothing: ${genesis.error?.message ?? "no response"}. A provider that accepts requests and never replies is the worst case — it hangs rather than fails.`,
        "host-call-failed",
        data,
      );
    }

    ctx.shared.hostSpeaksEth = chainId.ok;
    if (chainId.ok) {
      return ok(`Transport is live and answers eth_* directly (chainId ${data.ethChainId}).`, data);
    }
    return ok(
      `Transport is live (${list.length} methods) but does NOT answer eth_*. Contract reads need a translation layer — pine-rpc already implements eth_* over ReviveApi_* — or an external endpoint.`,
      data,
    );
  },
};

const hostMethods: Check = {
  id: "chain.hostMethods",
  title: "Which RPC methods does the host allow?",
  why: "rpc_methods returned nothing and eth_chainId came back 'not supported by the host', so the transport is an allowlist. Whether a runtime-call method is on it decides whether a contract can be read through the host at all, or only through an external endpoint.",
  gates: [],
  needs: ["chain.hostTransport"],
  timeoutMs: 90_000,
  async run(ctx) {
    const rpc = ctx.shared.hostRpc as HostRpc | undefined;
    if (!rpc) return skipped("No host transport open.");

    // Read-only, and each with parameters that cannot succeed. That is the
    // point: a "method not found" and an "invalid params" are the two answers
    // worth telling apart, and only the second proves the method exists.
    const candidates: [string, unknown[]][] = [
      ["chainSpec_v1_genesisHash", []],
      ["chainSpec_v1_chainName", []],
      ["chainSpec_v1_properties", []],
      // The runtime-call surface. ReviveApi_call rides on one of these, and it
      // is the whole question for a host-routed contract read.
      ["state_call", ["ReviveApi_call", "0x"]],
      ["state_getRuntimeVersion", []],
      ["state_getMetadata", []],
      ["archive_v1_call", ["0x", "ReviveApi_call", "0x"]],
      ["chainHead_v1_call", ["invalid-subscription", "0x", "ReviveApi_call", "0x"]],
      ["chainHead_v1_storage", ["invalid-subscription", "0x", []]],
      ["system_chain", []],
      ["system_health", []],
      ["system_properties", []],
      ["transaction_v1_broadcast", ["0x"]],
      ["author_submitExtrinsic", ["0x"]],
    ];

    const allowed: string[] = [];
    const blocked: string[] = [];
    // Three buckets, not two. 1.2.0 had only allowed/blocked and folded a
    // timeout into "reached the node", which reported chainHead_v1_call as
    // available on the strength of it never answering. An absent answer is not
    // evidence of anything and must say so.
    const noAnswer: string[] = [];
    const detail: Record<string, string> = {};

    for (const [method, params] of candidates) {
      const r = await rpc.call(method, params);
      if (r.ok) {
        allowed.push(method);
        detail[method] = `ok (${r.ms} ms)`;
        continue;
      }
      const text = r.error?.message ?? "";
      if (/not supported by the host|method not found|unknown method/i.test(text)) {
        blocked.push(method);
        detail[method] = "blocked by host";
      } else if (/^no response in/.test(text)) {
        // Our own timeout, not the node's error. For the chainHead_v1_*
        // family this is the expected result of asking wrongly rather than a
        // fault: those methods are the subscription-based spec, where a call
        // must carry a followSubscription from chainHead_v1_follow and its
        // *result* arrives as a notification, not as a reply to this id. This
        // transport correlates by id only, so it cannot see one.
        noAnswer.push(method);
        detail[method] = `no answer in ${r.ms} ms — not refused, but not answered`;
      } else {
        allowed.push(method);
        detail[method] = `reached the node — ${text.slice(0, 90)}`;
      }
    }

    const runtimeCall = allowed.filter((m) => /state_call|archive_v1_call|chainHead_v1_call/.test(m));
    const notRefused = noAnswer.filter((m) => /chainHead_v1_call|archive_v1_call|state_call/.test(m));
    const data = { allowed, blocked, noAnswer, detail, runtimeCallConfirmed: runtimeCall, runtimeCallNotRefused: notRefused };
    ctx.shared.runtimeCallAvailable = runtimeCall.length > 0 || notRefused.length > 0;

    if (runtimeCall.length) {
      return ok(`Runtime calls confirmed via ${runtimeCall.join(", ")}.`, data);
    }
    if (notRefused.length) {
      return ok(
        `The host does not refuse ${notRefused.join(", ")}, but this transport cannot drive it: chainHead_v1_call needs a followSubscription and delivers its result as a notification, not as a reply. That is a client-shape problem, not a permission one — PAPI implements the lifecycle, and pine-rpc drives contract reads through exactly this method. The legacy surface (state_call, archive_v1_call, system_*, author_*) is blocked outright, so this is the only door.`,
        data,
      );
    }
    return bad(
      "No runtime-call method is reachable and none was left unrefused. A pallet-revive contract cannot be read through this host at all — reads must go to an external endpoint, and the host's censorship story is not available to Broadside.",
      "method-not-found",
      data,
    );
  },
};

const controlRpc: Check = {
  id: "chain.controlRpc",
  title: "External Ethereum RPC — the control",
  why: "Isolates the host. If a read works here and not through the host, the fault is the host transport; if it fails here too, the fault is the deployment or the network policy.",
  gates: [],
  needs: [],
  timeoutMs: 30_000,
  async run(ctx) {
    if (!ETH_RPC_URL) {
      return skipped("No ETH_RPC_URL configured in product.mjs — the control path is disabled rather than silently testing nothing.", "no-address-configured");
    }
    const r = await ethChainId(ETH_RPC_URL);
    ctx.shared.controlWorks = r.ok;
    const data = { url: ETH_RPC_URL, chainId: r.ok ? r.result : null, ms: r.ms, error: r.ok ? null : r.error?.message };
    if (!r.ok) {
      return bad(
        `Could not reach it: ${r.error?.message}. Inside the app this may be the embedder's network policy rather than the endpoint.`,
        "network-blocked",
        data,
      );
    }
    return ok(`Reachable, chainId ${r.result}.`, data);
  },
};

const contractRead: Check = {
  id: "chain.contractRead",
  title: "Read the deployed contract",
  why: "Proves the address holds code on the chain the signature will be bound to. A domain separator built against the wrong chain id produces signatures that are valid-looking and never match.",
  gates: ["chainReachable"],
  // Deliberately depends on nothing. Run 1 gated this on chain.hostTransport,
  // so when the host could not serve the chain this skipped — and took gate 5
  // with it — even though the control path was working and could have answered
  // it. A check that can succeed by another route must not inherit the failure
  // of the route it did not need.
  needs: [],
  timeoutMs: 15_000,
  async run(ctx) {
    if (!CONTRACT_ADDRESS) {
      return skipped(
        "BroadsideSeam is not deployed yet — run contracts/scripts/deploy.mjs and re-sync the ABI.",
        "no-address-configured",
      );
    }
    ctx.mark("entered");
    const calldata = encodeChainId();
    ctx.mark(`encoded calldata ${calldata.slice(0, 12)}`);
    const attempts: Record<string, unknown> = {};

    if (ctx.shared.hostSpeaksEth) {
      ctx.mark("host eth_call: start");
      const rpc = ctx.shared.hostRpc as HostRpc;
      const r = await rpc.call("eth_call", [{ to: CONTRACT_ADDRESS, data: calldata }, "latest"]);
      ctx.mark("host eth_call: returned");
      attempts.host = r.ok ? { ...decodeResult("chainId", String(r.result)), ms: r.ms } : { ok: false, error: r.error?.message, ms: r.ms };
    }
    if (ETH_RPC_URL) {
      ctx.mark("control eth_call: start");
      // 8 s, well inside this check's 25 s budget, so a slow endpoint produces
      // a timed attempt with evidence rather than a check that burns its whole
      // budget and reports only that it ran out.
      const r = await ethCall(ETH_RPC_URL, CONTRACT_ADDRESS, calldata, 8_000);
      ctx.mark(`control eth_call: returned ok=${r.ok} in ${r.ms}ms`);
      attempts.control = r.ok
        ? { ...decodeResult("chainId", String(r.result)), ms: r.ms }
        : { ok: false, error: r.error?.message, ms: r.ms };
      ctx.mark("control eth_call: decoded");
    }

    const winner = pickWorking(attempts);
    const data = { address: CONTRACT_ADDRESS, expectedChainId: CONTRACT_CHAIN_ID, target: CONTRACT_TARGET, attempts, via: winner };
    if (!winner) {
      const why = Object.entries(attempts)
        .map(([k, v]) => `${k}: ${(v as { error?: string }).error ?? "no result"}`)
        .join("; ");
      return bad(`No transport could read the contract — ${why}.`, "host-call-failed", data);
    }

    ctx.shared.readVia = winner;
    const reported = Number((attempts[winner] as { value: unknown }).value);
    if (CONTRACT_CHAIN_ID != null && reported !== CONTRACT_CHAIN_ID) {
      return bad(
        `Contract reports chainId ${reported}, but the deployment recorded ${CONTRACT_CHAIN_ID}. Every EIP-712 signature bound to the recorded id will fail here while looking well-formed.`,
        "recovery-mismatch",
        { ...data, reportedChainId: reported },
      );
    }
    return ok(`Contract read via ${winner}; chainId ${reported}.`, { ...data, reportedChainId: reported });
  },
};

// ── gate 5: does ecrecover accept the burner ────────────────────────────────

const signLocal: Check = {
  id: "seam.signLocal",
  title: "Sign EIP-712 with the burner, recover locally",
  why: "Costs nothing and needs no chain. If this fails, nothing downstream is worth running; if it passes, any on-chain mismatch is the chain's disagreement, not a malformed signature.",
  gates: ["recoverAccepted"],
  needs: ["burner.derive"],
  timeoutMs: 30_000,
  async run(ctx) {
    const b = ctx.shared.burner as { wallet: Wallet; address: string } | undefined;
    if (!b) return skipped("No burner.");

    // Falls back to the recorded chain id, or 0 when undeployed: the local
    // round trip does not touch the chain, so the value only has to be the same
    // on both sides of it.
    const chainId = CONTRACT_CHAIN_ID ?? 0;
    const verifying = CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";
    const value = freshSeam(b.address, BigInt(Date.now()));

    try {
      const signed = await signSeam(b.wallet, value, chainId, verifying);
      ctx.shared.signed = signed;
      const matches = signed.localRecovered.toLowerCase() === b.address.toLowerCase();
      const data = {
        signer: b.address,
        recovered: signed.localRecovered,
        matches,
        digest: signed.localDigest,
        chainId,
        verifyingContract: verifying,
        nonce: String(value.nonce),
      };
      return matches
        ? ok("Signed and recovered locally — the signature is self-consistent.", data)
        : bad(`Local recovery gave ${signed.localRecovered}, expected ${b.address}.`, "recovery-mismatch", data);
    } catch (e) {
      return bad(`signTypedData threw: ${msg(e)}`, "threw");
    }
  },
};

const recoverOnChain: Check = {
  id: "seam.recoverOnChain",
  title: "The contract's ecrecover accepts it",
  why: "The whole gate. A PolkaVM contract recovering the app-local burner from an EIP-712 signature is what makes gasless per-impression claims possible; it is deliberately a view call so it costs nothing and works on an unfunded device.",
  gates: ["recoverAccepted"],
  needs: ["seam.signLocal", "chain.contractRead"],
  timeoutMs: 25_000,
  async run(ctx) {
    const signed = ctx.shared.signed as { value: { viewer: string; nonce: bigint; note: string }; signature: string; localDigest: string } | undefined;
    const b = ctx.shared.burner as { address: string };
    if (!signed) return skipped("Nothing signed.");
    if (!CONTRACT_ADDRESS) return skipped("BroadsideSeam is not deployed.", "no-address-configured");

    const calldata = encodeRecover(signed.value, signed.signature);
    const via = ctx.shared.readVia as string | undefined;
    let raw: string | null = null;
    let error: string | null = null;

    if (via === "host") {
      const rpc = ctx.shared.hostRpc as HostRpc;
      const r = await rpc.call("eth_call", [{ to: CONTRACT_ADDRESS, data: calldata }, "latest"]);
      if (r.ok) raw = String(r.result);
      else error = r.error?.message ?? "call failed";
    } else if (via === "control" && ETH_RPC_URL) {
      const r = await ethCall(ETH_RPC_URL, CONTRACT_ADDRESS, calldata);
      if (r.ok) raw = String(r.result);
      else error = r.error?.message ?? "call failed";
    } else {
      return skipped("No working transport established.");
    }

    if (raw == null) return bad(`eth_call failed: ${error}`, "host-call-failed", { via, error });

    const decoded = decodeResult("recover", raw);
    if (!decoded.ok) {
      // The contract reverts with a named error per failure mode precisely so
      // this line can say which one.
      return bad(`The contract rejected it: ${decoded.error}`, "recovery-mismatch", { via, raw: raw.slice(0, 80) });
    }
    const recovered = String(decoded.value);
    const matches = recovered.toLowerCase() === b.address.toLowerCase();
    const data = { via, recovered, expected: b.address, matches, localDigest: signed.localDigest, target: CONTRACT_TARGET };
    return matches
      ? ok(
          `The contract recovered ${short(recovered)} — the same key the host's entropy produced. A ${CONTRACT_TARGET ?? "deployed"} contract accepts a burner signature.`,
          data,
        )
      : bad(
          `The contract recovered ${recovered}, not ${b.address}. The signature is valid but binds to a different domain — check chainId and verifyingContract.`,
          "recovery-mismatch",
          data,
        );
  },
};

const attestWrite: Check = {
  id: "seam.attest",
  title: "The same proof, as a transaction",
  why: "A view call proves recovery; a receipt proves the whole path including gas, nonce and inclusion. Needs a funded account, which a probe on a stranger's phone will not have — so it reports what to fund rather than failing.",
  gates: [],
  needs: ["seam.recoverOnChain"],
  timeoutMs: 20_000,
  async run(ctx) {
    const b = ctx.shared.burner as { address: string };
    if (!ETH_RPC_URL) {
      return skipped(
        "A write needs an endpoint that accepts eth_sendRawTransaction. Set ETH_RPC_URL in product.mjs to enable it.",
        "no-address-configured",
      );
    }
    const balance = await ethChainId(ETH_RPC_URL);
    if (!balance.ok) return skipped(`Control RPC unreachable: ${balance.error?.message}`, "network-blocked");

    return skipped(
      `Not attempted — the burner needs gas first. Fund ${b.address} on the target chain and re-run; because derivation is deterministic, funding it once makes every later run on this device work.`,
      "unfunded",
      { fundThisAddress: b.address, chainId: balance.result },
    );
  },
};

function pickWorking(attempts: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(attempts)) {
    if ((v as { ok?: boolean })?.ok) return k;
  }
  return null;
}

export const CHECKS: Check[] = [
  container,
  handshake,
  app,
  entropyDeterminism,
  burner,
  entropyCrossSession,
  aliasInSession,
  productAlias,
  aliasCrossSession,
  productAccounts,
  userId,
  hostSupports,
  hostTransport,
  hostMethods,
  controlRpc,
  contractRead,
  signLocal,
  recoverOnChain,
  attestWrite,
];

export type { Ctx };
