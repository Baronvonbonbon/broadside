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
import { JsonRpcProvider as EthProvider } from "ethers";

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

  static async open(genesis: Hex, timeoutMs = 15_000): Promise<HostRpc | null> {
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

  async call(method: string, params: unknown[] = []): Promise<RpcResult> {
    const id = this.#nextId++;
    const t0 = performance.now();
    const conn = this.#conn;
    if (!conn) return { ok: false, error: { message: "connection closed" }, ms: 0 };

    return new Promise<RpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: { message: `no response in ${this.timeoutMs} ms` }, ms: Math.round(performance.now() - t0) });
      }, this.timeoutMs);

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

/** The control path: a plain Ethereum RPC, reached by ordinary fetch. */
export async function ethCall(url: string, to: string, data: string, timeoutMs = 15_000): Promise<RpcResult> {
  const provider = new EthProvider(url, undefined, { staticNetwork: true });
  const t0 = performance.now();
  try {
    const result = await withTimeout(provider.call({ to, data }), timeoutMs);
    return { ok: true, result, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, error: { message: (e as Error).message }, ms: Math.round(performance.now() - t0) };
  } finally {
    provider.destroy();
  }
}

export async function ethChainId(url: string, timeoutMs = 15_000): Promise<RpcResult> {
  const provider = new EthProvider(url, undefined, { staticNetwork: true });
  const t0 = performance.now();
  try {
    const net = await withTimeout(provider.getNetwork(), timeoutMs);
    return { ok: true, result: Number(net.chainId), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, error: { message: (e as Error).message }, ms: Math.round(performance.now() - t0) };
  } finally {
    provider.destroy();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
  ]);
}
