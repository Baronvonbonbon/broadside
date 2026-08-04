/**
 * Two ways to reach a contract, and the difference between them is the point.
 *
 * `getHostProvider()` returns **polkadot-api**'s `JsonRpcProvider`, not
 * ethers'. That is a Substrate JSON-RPC transport — raw message passing over
 * `truApi.chain.*` — so an `eth_call` is not something it can obviously do.
 * Whether the host speaks Ethereum RPC at all decides the entire client
 * architecture: if it does, the widget talks to pallet-revive directly through
 * the host; if it does not, every contract read has to go through a translation
 * layer (pine-rpc already implements exactly that, eth_* → ReviveApi_*) or out
 * to an external endpoint, which gives up the host's censorship story.
 *
 * So the probe asks the transport what methods it has rather than assuming, and
 * runs the same read through an external Ethereum RPC as a control. One of them
 * failing is informative. Both failing is a different finding entirely.
 */

import { getHostProvider } from "@parity/product-sdk-host";

export type Hex = `0x${string}`;

export interface RpcResult {
  ok: boolean;
  result?: unknown;
  error?: { code?: number; message: string };
  ms: number;
}

/**
 * Promise-shaped access to a PAPI provider.
 *
 * PAPI's provider is `(onMessage) => { send, disconnect }` — one callback for
 * every message on the connection, with correlation left to the caller. This
 * wraps it in request/response and, importantly, bounds the wait: a host that
 * accepts a request and never answers is the failure mode that cost `kite` a
 * session, and it is indistinguishable from a slow one without a timeout.
 */
export class HostRpc {
  #conn: { send: (m: unknown) => void; disconnect: () => void } | null = null;
  #pending = new Map<number, (m: { result?: unknown; error?: { code?: number; message: string } }) => void>();
  #nextId = 1;

  private constructor(private readonly timeoutMs: number) {}

  static async open(genesis: Hex, timeoutMs = 12_000): Promise<HostRpc | null> {
    const provider = await getHostProvider(genesis);
    if (!provider) return null;
    const rpc = new HostRpc(timeoutMs);
    rpc.#conn = provider((message: unknown) => {
      const m = message as { id?: number; result?: unknown; error?: { code?: number; message: string } };
      // Subscription notifications carry no id. Nothing here subscribes, so
      // they are noise rather than a case to handle.
      if (typeof m?.id !== "number") return;
      const settle = rpc.#pending.get(m.id);
      if (settle) {
        rpc.#pending.delete(m.id);
        settle(m);
      }
    }) as { send: (m: unknown) => void; disconnect: () => void };
    return rpc;
  }

  /** `timeoutMs` overrides the connection default — some probes know in advance
   *  that a method will not answer and should not spend twelve seconds proving
   *  it again on every run. */
  async call(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs): Promise<RpcResult> {
    const id = this.#nextId++;
    const t0 = performance.now();
    const conn = this.#conn;
    if (!conn) return { ok: false, error: { message: "connection closed" }, ms: 0 };

    return new Promise<RpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: { message: `no response in ${timeoutMs} ms` }, ms: Math.round(performance.now() - t0) });
      }, timeoutMs);

      this.#pending.set(id, (m) => {
        clearTimeout(timer);
        const ms = Math.round(performance.now() - t0);
        if (m.error) resolve({ ok: false, error: m.error, ms });
        else resolve({ ok: true, result: m.result, ms });
      });

      try {
        conn.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve({ ok: false, error: { message: `send threw: ${(e as Error).message}` }, ms: Math.round(performance.now() - t0) });
      }
    });
  }

  close(): void {
    for (const settle of this.#pending.values()) settle({ error: { message: "closed" } });
    this.#pending.clear();
    try {
      this.#conn?.disconnect();
    } catch {
      // Disconnecting a connection the host already tore down is not a fault.
    }
    this.#conn = null;
  }
}

/**
 * The control path: a plain Ethereum RPC, by raw `fetch`.
 *
 * This used ethers' `JsonRpcProvider` and `chain.contractRead` stalled three
 * runs in a row on it, while the identical call succeeded from Node against the
 * same endpoint and calldata. Rather than keep guessing at network detection,
 * request batching, and the provider's own polling and teardown, the probe now
 * issues the JSON-RPC POST itself.
 *
 * The point is not that it is smaller. It is that `AbortController` **actually
 * cancels the request**, where `Promise.race` only stops waiting for it — and
 * "the losing promise is still pending" is precisely the caveat every previous
 * timeout in this suite had to carry. Here there is nothing left running.
 *
 * ethers is still used for ABI encoding and signing, which touch no network.
 */
async function jsonRpc(url: string, method: string, params: unknown[], timeoutMs: number): Promise<RpcResult> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, error: { message: `HTTP ${res.status}` }, ms };
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message: string } };
    if (body.error) return { ok: false, error: body.error, ms };
    return { ok: true, result: body.result, ms };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const aborted = (e as Error).name === "AbortError";
    return {
      ok: false,
      error: { message: aborted ? `aborted after ${timeoutMs} ms` : `${(e as Error).name}: ${(e as Error).message}` },
      ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function ethCall(url: string, to: string, data: string, timeoutMs = 12_000): Promise<RpcResult> {
  return jsonRpc(url, "eth_call", [{ to, data }, "latest"], timeoutMs);
}

export async function ethChainId(url: string, timeoutMs = 12_000): Promise<RpcResult> {
  const r = await jsonRpc(url, "eth_chainId", [], timeoutMs);
  return r.ok ? { ...r, result: Number(r.result) } : r;
}
