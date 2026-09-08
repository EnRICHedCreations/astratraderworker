import { USDC, JUPITER, TOKEN, assets } from "./config.mjs";
import { createHash } from "node:crypto";
// Restrict attribution to an explicit Jupiter program invocation. Never promote
// arbitrary opposite token transfers into swap evidence.
export function decode(tx, signature, slot, receivedAt = Date.now()) {
  if (!tx?.meta || tx.meta.err || !tx.blockTime)
    return { trades: [], edges: [], transfers: [] };
  const at = tx.blockTime * 1000,
    keys = tx.transaction.message.accountKeys;
  const instructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions),
  ];
  const isSwap = instructions.some((i) => i.programId === JUPITER);
  const signers = new Set(keys.filter((k) => k.signer).map((k) => k.pubkey));
  const all = new Map();
  for (const [field, mul] of [
    ["preTokenBalances", -1n],
    ["postTokenBalances", 1n],
  ])
    for (const b of tx.meta[field] ?? []) {
      if (!b.owner) continue;
      const key = b.owner + ":" + b.mint,
        old = all.get(key) ?? {
          wallet: b.owner,
          mint: b.mint,
          raw: 0n,
          decimals: b.uiTokenAmount.decimals,
        };
      old.raw += mul * BigInt(b.uiTokenAmount.amount);
      all.set(key, old);
    }
  const trades = [],
    transfers = [],
    edges = [];
  for (const w of signers) {
    const deltas = [...all.values()].filter(
        (x) => x.wallet === w && x.raw !== 0n,
      ),
      usd = deltas.find((x) => x.mint === USDC),
      others = deltas.filter((x) => x.mint !== USDC);
    if (isSwap && usd && others.length === 1 && usd.raw * others[0].raw < 0n) {
      const t = others[0];
      trades.push({
        id: signature + ":" + w + ":" + t.mint,
        signature,
        slot,
        at,
        receivedAt,
        wallet: w,
        mint: t.mint,
        side: t.raw > 0n ? "buy" : "sell",
        rawQty: (t.raw < 0n ? -t.raw : t.raw).toString(),
        decimals: t.decimals,
        usdRaw: (usd.raw < 0n ? -usd.raw : usd.raw).toString(),
        feeLamports: tx.meta.fee,
        classification:
          "Jupiter invocation with single signer-owned USDC/token delta",
      });
    } else
      for (const d of deltas)
        if (d.mint !== USDC)
          transfers.push({
            id: signature + ":transfer:" + w + ":" + d.mint,
            wallet: w,
            mint: d.mint,
            side: "transfer",
            at,
            slot,
            rawQty: d.raw.toString(),
            signature,
          });
  }
  for (const i of instructions) {
    const p = i.parsed;
    if (i.program === "system" && p?.type === "transfer")
      edges.push({
        a: p.info.source,
        b: p.info.destination,
        kind: "funding",
        at,
        signature,
        lamports: p.info.lamports,
      });
    if (
      i.program === "spl-token" &&
      ["mintTo", "mintToChecked", "initializeMint", "initializeMint2"].includes(
        p?.type,
      )
    )
      edges.push({
        kind: p.type,
        a: p.info.mintAuthority ?? p.info.authority,
        b: p.info.mint,
        at,
        signature,
      });
  }
  return { trades, edges, transfers };
}
export function walletScore(observations, asOf = Date.now()) {
  const inv = new Map(),
    rounds = [];
  let realized = 0,
    tainted = 0;
  for (const t of observations
    .filter((t) => t.at <= asOf)
    .sort(
      (a, b) => a.at - b.at || a.slot - b.slot || a.id.localeCompare(b.id),
    )) {
    let p = inv.get(t.mint) ?? {
      qty: 0n,
      cost: 0,
      pnl: 0,
      totalCost: 0,
      tainted: false,
      openedAt: t.at,
    };
    if (t.side === "transfer") {
      p.tainted = true;
      tainted++;
      inv.set(t.mint, p);
      continue;
    }
    const qty = BigInt(t.rawQty);
    if (qty <= 0n) continue;
    const usd = Number(t.usdRaw) / 1e6;
    if (t.side === "buy") {
      const cost = usd + 0.02;
      p.qty += qty;
      p.cost += cost;
      p.totalCost += cost;
    } else if (p.qty >= qty && !p.tainted) {
      const cost = (p.cost * Number(qty)) / Number(p.qty),
        profit = usd - 0.02 - cost;
      p.qty -= qty;
      p.cost -= cost;
      p.pnl += profit;
      realized += profit;
      if (p.qty === 0n) {
        rounds.push({
          pnl: p.pnl,
          return: p.pnl / p.totalCost,
          at: t.at,
          holdingMs: t.at - p.openedAt,
        });
        p = {
          qty: 0n,
          cost: 0,
          pnl: 0,
          totalCost: 0,
          tainted: false,
          openedAt: t.at,
        };
      }
    } else {
      p.tainted = true;
      tainted++;
    }
    inv.set(t.mint, p);
  }
  const n = rounds.length,
    wins = rounds.filter((r) => r.pnl > 0),
    losses = rounds.filter((r) => r.pnl <= 0),
    mean = rounds.reduce((s, r) => s + r.return, 0) / (n || 1),
    variance =
      rounds.reduce((s, r) => s + (r.return - mean) ** 2, 0) /
      Math.max(1, n - 1),
    lower = mean - 1.96 * Math.sqrt(variance / Math.max(1, n));
  const score = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        50 +
          30 * Math.tanh(mean * 5) +
          20 * ((2 * (wins.length + 2)) / (n + 4) - 1),
      ),
    ),
  );
  return {
    score,
    roundTrips: n,
    pnl: realized,
    wins: wins.length,
    losses: losses.length,
    confidence: Math.min(1, n / 50),
    expectancy: mean,
    lowerMean95: lower,
    profitFactor:
      losses.length && losses.some((r) => r.pnl < 0)
        ? wins.reduce((s, r) => s + r.pnl, 0) /
          -losses.reduce((s, r) => s + r.pnl, 0)
        : null,
    taintedInventoryEvents: tainted,
    eligible: n >= 30 && lower > 0 && score >= 70 && tainted === 0,
    copyability:
      "Not established by wallet P&L; verified separately with delayed router quotes",
    asOf,
  };
}
export function relationshipGroups(wallets, edges, trades) {
  const parent = new Map(wallets.map((w) => [w, w]));
  const root = (w) => {
    if (!parent.has(w)) parent.set(w, w);
    let r = w;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  const join = (a, b) => parent.set(root(a), root(b));
  const evidence = [];
  const funders = new Map();
  for (const e of edges.filter((e) => e.kind === "funding")) {
    if (wallets.includes(e.a) && wallets.includes(e.b)) {
      join(e.a, e.b);
      evidence.push({
        ...e,
        reason: "Direct funding; conservative correlation group",
      });
    }
    const set = funders.get(e.a) ?? new Set();
    set.add(e.b);
    funders.set(e.a, set);
  }
  for (const [f, targets] of funders) {
    const ws = [...targets].filter((w) => wallets.includes(w));
    if (ws.length > 1 && targets.size <= 20) {
      for (const w of ws) join(ws[0], w);
      evidence.push({
        reason: "Shared non-hub funding source",
        funder: f,
        wallets: ws,
      });
    }
  }
  const bins = new Map();
  for (const t of trades.filter((t) => t.side === "buy")) {
    const k = t.mint + ":" + Math.floor(t.at / 10000);
    const list = bins.get(k) ?? new Set();
    list.add(t.wallet);
    bins.set(k, list);
  }
  const pairs = new Map();
  for (const set of bins.values()) {
    const ws = [...set].sort();
    if (ws.length > 20) continue;
    for (let i = 0; i < ws.length; i++)
      for (let j = i + 1; j < ws.length; j++) {
        const k = ws[i] + ":" + ws[j];
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
  }
  for (const [key, n] of pairs)
    if (n >= 3) {
      const [a, b] = key.split(":");
      join(a, b);
      evidence.push({
        a,
        b,
        coentries: n,
        reason: "Repeated synchronized entries; correlated evidence",
      });
    }
  return {
    groups: Object.fromEntries(wallets.map((w) => [w, root(w)])),
    evidence,
    interpretation:
      "Correlation groups reduce confirmation counts; they do not prove wallet ownership",
  };
}
export async function inspect(mint, p, c) {
  const at = Date.now(),
    reasons = [];
  const account = await p.rpc("getAccountInfo", [
    mint,
    { encoding: "jsonParsed", commitment: "finalized" },
  ]);
  const info = account?.value?.data?.parsed?.info;
  if (account?.value?.owner !== TOKEN || !info)
    reasons.push("Unsupported mint program");
  if (info?.mintAuthority !== null)
    reasons.push("Mint authority active/unknown");
  if (info?.freezeAuthority !== null)
    reasons.push("Freeze authority active/unknown");
  const pair = (await p.pairs(mint))[0];
  const liquidity = pair?.liquidity?.usd ?? 0;
  if (liquidity < c.minLiquidity) reasons.push("Insufficient liquidity");
  const largest = await p.rpc("getTokenLargestAccounts", [
    mint,
    { commitment: "finalized" },
  ]);
  const addresses = largest.value.map((a) => a.address);
  const owners = addresses.length
    ? await p.rpc("getMultipleAccounts", [
        addresses,
        { encoding: "jsonParsed", commitment: "finalized" },
      ])
    : { value: [] };
  const concentration = new Map();
  largest.value.forEach((a, i) => {
    const owner = owners.value[i]?.data?.parsed?.info?.owner;
    if (!owner) {
      reasons.push("Holder owner unresolved");
      return;
    }
    concentration.set(
      owner,
      (concentration.get(owner) ?? 0n) + BigInt(a.amount),
    );
  });
  const supply = BigInt(info?.supply ?? 0);
  const topOwners = [...concentration.values()]
    .sort((a, b) => (a > b ? -1 : 1))
    .slice(0, 10);
  const top10 =
    supply > 0n
      ? Number(topOwners.reduce((a, b) => a + b, 0n)) / Number(supply)
      : null;
  if (top10 === null || top10 > 0.3)
    reasons.push("Concentrated holder ownership");
  const approval = assets(c).find((a) => a.mint === mint);
  if (!approval) reasons.push("No current deployer/supply review");
  return {
    mint,
    at,
    symbol: String(pair?.baseToken?.symbol ?? mint.slice(0, 6)).slice(0, 24),
    price: Number(pair?.priceUsd ?? 0),
    liquidity,
    decimals: info?.decimals,
    mintAuthority: info?.mintAuthority,
    freezeAuthority: info?.freezeAuthority,
    top10,
    holderOwners: [...concentration].map(([owner, raw]) => ({
      owner,
      raw: raw.toString(),
    })),
    approval: approval ?? null,
    reasons,
    allowed: reasons.length === 0,
    score: Math.max(0, 100 - reasons.length * 20),
    deployerVerified: !!approval,
    provenance: {
      rpc: "finalized",
      market: "DexScreener",
      deployer: "Operator-reviewed evidence file, not automatic proof",
    },
  };
}
export function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
