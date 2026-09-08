import { setTimeout as sleep } from "node:timers/promises";
export async function json(url, options = {}, retry = true) {
  for (let i = 0; ; i++) {
    let r;
    try {
      r = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    } catch {
      if (retry && i < 2) {
        await sleep(250 * 2 ** i);
        continue;
      }
      throw Error("Provider transport unavailable");
    }
    if (retry && (r.status === 429 || r.status >= 500) && i < 2) {
      await sleep(
        Math.min(
          5000,
          Number(r.headers.get("retry-after") ?? 0) * 1000 || 500 * 2 ** i,
        ),
      );
      continue;
    }
    if (!r.ok) throw Error(`Provider HTTP ${r.status}`);
    try {
      return await r.json();
    } catch {
      throw Error("Provider returned invalid JSON");
    }
  }
}
export class Providers {
  constructor(c) {
    this.c = c;
  }
  async rpc(method, params = []) {
    const r = await json(
      this.c.rpc,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
      !["sendTransaction"].includes(method),
    );
    if (r.error) throw Error(`RPC ${method} code ${r.error.code}`);
    return r.result;
  }
  async quote(inputMint, outputMint, amount, taker) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amount),
      swapMode: "ExactIn",
      slippageBps: String(this.c.slippageBps),
      excludeRouters: "jupiterz,dflow,okx",
      ...(taker ? { taker } : {}),
    });
    const q = await json(`https://api.jup.ag/swap/v2/order?${params}`, {
      headers: { "x-api-key": this.c.jupiterKey },
    });
    return { ...q, observedAt: Date.now() };
  }
  async execute(q, signed) {
    return json(
      "https://api.jup.ag/swap/v2/execute",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.c.jupiterKey,
        },
        body: JSON.stringify({
          requestId: q.requestId,
          signedTransaction: signed,
          lastValidBlockHeight: q.lastValidBlockHeight,
        }),
      },
      false,
    );
  }
  async pairs(mint) {
    const list = await json(
      `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`,
    );
    if (!Array.isArray(list)) throw Error("Invalid pair response");
    return list
      .filter((p) => p.baseToken?.address === mint)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  }
}
