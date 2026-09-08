import { readFileSync } from "node:fs";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export function integer(value, name, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`Invalid ${name}`);
  return n;
}
export function config(e = process.env) {
  const c = {
    mode: e.TRADING_MODE ?? "paper",
    disableDiscovery: e.DISABLE_DISCOVERY === "true",
    port: integer(e.PORT ?? 8080, "PORT", 1, 65535),
    db: e.DATABASE_PATH ?? "/data/trader.sqlite",
    rpc: e.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    apiToken: e.ADMIN_TOKEN ?? "",
    webhookToken: e.INGEST_TOKEN ?? "",
    jupiterKey: e.JUPITER_API_KEY ?? "",
    signerURL: e.SIGNER_URL ?? "http://signer:8090",
    signerTransport: e.SIGNER_TRANSPORT ?? "http",
    signerToken: e.SIGNER_TOKEN ?? "",
    assetsFile: e.ASSET_POLICY_FILE ?? "/config/approved-assets.json",
    paperBalance: integer(
      e.PAPER_BALANCE_USDC ?? 1000,
      "PAPER_BALANCE_USDC",
      1,
      1000000,
    ),
    pollMs: integer(e.POLL_MS ?? 1000, "POLL_MS", 250, 60000),
    minLiquidity: 100000,
    minRounds: 30,
    minConfidence: 0.6,
    maxLagMs: 15000,
    quoteAgeMs: 5000,
    slippageBps: integer(e.MAX_SLIPPAGE_BPS ?? 50, "MAX_SLIPPAGE_BPS", 1, 100),
    signerEnabled: e.SIGNER_ENABLE_LIVE === "true",
    keyPath: e.SIGNER_KEYPAIR_FILE ?? "",
    keyBase64: e.SIGNER_KEYPAIR_BASE64 ?? "",
    budget: integer(e.LIVE_BUDGET_USDC ?? 0, "LIVE_BUDGET_USDC", 0, 1000000),
    maxOrder: integer(
      e.LIVE_MAX_ORDER_USDC ?? 0,
      "LIVE_MAX_ORDER_USDC",
      0,
      100000,
    ),
    maxDaily: integer(
      e.LIVE_DAILY_BUY_LIMIT_USDC ?? 0,
      "LIVE_DAILY_BUY_LIMIT_USDC",
      0,
      1000000,
    ),
    maxLoss: integer(
      e.LIVE_DAILY_LOSS_LIMIT_USDC ?? 0,
      "LIVE_DAILY_LOSS_LIMIT_USDC",
      0,
      100000,
    ),
    maxLamports: integer(
      e.MAX_NATIVE_COST_LAMPORTS ?? 5000000,
      "MAX_NATIVE_COST_LAMPORTS",
      5000,
      10000000,
    ),
    minReserve: integer(
      e.MIN_SOL_RESERVE_LAMPORTS ?? 10000000,
      "MIN_SOL_RESERVE_LAMPORTS",
      1000000,
      1000000000,
    ),
    approvalHash: e.LIVE_APPROVAL_SHA256 ?? "",
    discoveryPrograms: (e.DISCOVERY_PROGRAMS ?? JUPITER)
      .split(",")
      .filter(Boolean),
  };
  if (!["paper", "live"].includes(c.mode))
    throw Error("TRADING_MODE must be paper or live");
  for (const url of [c.rpc])
    if (new URL(url).protocol !== "https:") throw Error("RPC must use HTTPS");
  return c;
}
export function assets(c) {
  try {
    const a = JSON.parse(readFileSync(c.assetsFile, "utf8"));
    if (!Array.isArray(a)) throw Error();
    return a.filter(
      (x) =>
        typeof x.mint === "string" &&
        Number.isFinite(x.expiresAt) &&
        x.expiresAt > Date.now() &&
        typeof x.reviewedBy === "string" &&
        x.reviewedBy.length &&
        typeof x.evidence === "string" &&
        x.evidence.length >= 20,
    );
  } catch {
    return [];
  }
}
export function liveConfiguration(c) {
  return [
    ["Explicit live mode", c.mode === "live"],
    ["Signer enabled", c.signerEnabled],
    ["Capital budget", c.budget > 0],
    ["Per-order cap", c.maxOrder > 0 && c.maxOrder <= c.budget * 0.02],
    ["Daily buy cap", c.maxDaily > 0],
    ["Daily loss cap", c.maxLoss > 0 && c.maxLoss <= c.budget * 0.1],
    ["Approval artifact hash", /^[a-f0-9]{64}$/.test(c.approvalHash)],
    ["Dedicated RPC", !c.rpc.includes("api.mainnet-beta.solana.com")],
    ["Jupiter credentials", !!c.jupiterKey],
    ["Signer authentication", c.signerToken.length >= 32],
    ["Reviewed asset policy", assets(c).length > 0],
  ];
}
