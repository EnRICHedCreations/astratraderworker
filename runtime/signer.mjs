import { Keypair, Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { Providers } from "./providers.mjs";
import { USDC, liveConfiguration, assets } from "./config.mjs";
import { inspect } from "./intelligence.mjs";
import {
  validateIntent,
  validateQuote,
  validateTransaction,
} from "./guard.mjs";
export function approval(c) {
  try {
    const bytes = process.env.LIVE_APPROVAL_BASE64 ? Buffer.from(process.env.LIVE_APPROVAL_BASE64,"base64") : readFileSync(process.env.LIVE_APPROVAL_FILE ?? "/config/live-approval.json");
    const h = createHash("sha256").update(bytes).digest("hex");
    const a = JSON.parse(bytes);
    return (
      h === c.approvalHash &&
      a.operatorApproved === true &&
      a.closedPaperTrades >= 100 &&
      a.outOfSampleReturn > 0 &&
      a.maxDrawdown <= 0.1 &&
      a.successfulReconciliationTests === true &&
      a.routeSimulationValidated === true &&
      Date.now() - a.generatedAt < 7 * 86400000 &&
      a.generatedAt <= Date.now() &&
      /^[a-f0-9]{64}$/.test(a.datasetHash)
    );
  } catch {
    return false;
  }
}
export class Signer {
  constructor(c, store, dependencies = {}) {
    this.c = c;
    this.s = store;
    this.inspect = dependencies.inspect ?? inspect;
    this.p = dependencies.provider ?? new Providers(c);
    this.key = null;
    this.busy = false;
    if (c.signerEnabled && (c.keyPath || c.keyBase64)) {
      let bytes;
      if(c.keyBase64){bytes=Buffer.from(c.keyBase64,'base64');if(bytes.length!==64)throw Error('Invalid base64 keypair length');}
      else {if(statSync(c.keyPath).mode & 0o077)throw Error('Key file must not be group/world readable');const b=JSON.parse(readFileSync(c.keyPath,'utf8'));if(!Array.isArray(b)||b.length!==64||!b.every(v=>Number.isInteger(v)&&v>=0&&v<=255))throw Error('Invalid keypair file');bytes=Uint8Array.from(b);}
      this.key=Keypair.fromSecretKey(bytes);
    }
    this.wallet = this.key?.publicKey.toBase58() ?? null;
    this.p.connection ??= new Connection(c.rpc, "confirmed");
  }
  readiness() {
    return {
      wallet: this.wallet,
      enabled: this.c.signerEnabled,
      checks: [
        ...liveConfiguration(this.c),
        ["Dedicated signing key loaded", !!this.key],
        ["Reviewed paper evidence", approval(this.c)],
        ["Kill switch clear", !this.s.get("killed", false)],
      ],
      unresolved: this.s
        .orders()
        .filter((o) => ["signed", "submitted", "unknown"].includes(o.state))
        .length,
    };
  }
  async execute(intent) {
    if (this.busy) throw Error("Signer busy");
    this.busy = true;
    try {
      const existing = this.s.order(intent?.id);
      if (existing) {
        if (
          existing.intent &&
          JSON.stringify(existing.intent) !== JSON.stringify(intent)
        )
          throw Error("Order id conflicts with original intent");
        return this.public(existing);
      }
      if (!this.readiness().checks.every((x) => x[1]))
        throw Error("Live readiness gate not satisfied");
      if (
        this.s
          .orders()
          .some((o) => ["signed", "submitted", "unknown"].includes(o.state))
      )
        throw Error("Unresolved transaction blocks new orders");
      validateIntent(intent, this.c, this.wallet);
      const buy = intent.inputMint === USDC,
        mint = buy ? intent.outputMint : intent.inputMint;
      const holdings = this.s.get("holdings", {}),
        held = holdings[mint];
      if (!buy && (!held || BigInt(intent.amount) > BigInt(held.raw)))
        throw Error("Exit exceeds reconciled tracked inventory");
      if (buy) {
        const risk = await this.inspect(mint, this.p, this.c);
        if (!risk.allowed) throw Error("Fresh token risk check rejected entry");
        const exposure = Object.values(holdings).reduce(
          (n, h) => n + h.costRaw,
          0,
        );
        if (exposure + Number(intent.amount) > this.c.budget * 1e6 * 0.15)
          throw Error("Portfolio exposure limit");
        const loss = this.s.get(
          "loss:" + new Date().toISOString().slice(0, 10),
          0,
        );
        if (loss >= this.c.maxLoss * 1e6) throw Error("Daily loss stop");
        this.s.reserve(intent.id, Number(intent.amount), this.c.maxDaily * 1e6);
      }
      const q = await this.p.quote(
        intent.inputMint,
        intent.outputMint,
        intent.amount,
        this.wallet,
      );
      validateQuote(q, intent, this.c, this.wallet);
      const tx = await validateTransaction(
        q,
        intent,
        this.c,
        this.wallet,
        this.p,
      );
      if (Date.now() - q.observedAt > this.c.quoteAgeMs)
        throw Error("Quote expired during validation");
      if (this.s.get("killed", false)) throw Error("Kill switch enabled");
      if (
        (await this.p.rpc("getBlockHeight", [{ commitment: "confirmed" }])) >=
        Number(q.lastValidBlockHeight) - 5
      )
        throw Error("Transaction near expiry");
      tx.sign([this.key]);
      const signed = Buffer.from(tx.serialize()).toString("base64"),
        signature = bs58.encode(tx.signatures[0]);
      let o = {
        id: intent.id,
        intent,
        state: "signed",
        signature,
        signed,
        quote: {
          requestId: q.requestId,
          lastValidBlockHeight: q.lastValidBlockHeight,
          otherAmountThreshold: q.otherAmountThreshold,
        },
        at: Date.now(),
      };
      this.s.tx(() => {
        this.s.saveOrder(o);
        this.s.event("SIGNED", { id: o.id, signature });
      });
      // Signed bytes are persisted before network submission. A timeout never creates
      // a replacement transaction. Only reconciliation may resolve uncertainty.
      try {
        const result = await this.p.execute(q, signed);
        if (result.signature && result.signature !== signature)
          throw Error("Provider signature mismatch");
        o.state = "submitted";
        o.providerStatus = result.status ?? "unknown";
        this.s.saveOrder(o);
      } catch {
        o.state = "unknown";
        this.s.saveOrder(o);
        this.s.event("SUBMISSION_UNCERTAIN", { id: o.id, signature });
      }
      return this.public(o);
    } finally {
      this.busy = false;
    }
  }
  public(o) {
    return {
      id: o.id,
      state: o.state,
      signature: o.signature,
      at: o.at,
      result: o.result ?? null,
    };
  }
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const o of this.s
        .orders()
        .filter((o) => ["signed", "submitted", "unknown"].includes(o.state))) {
        const status = await this.p.rpc("getSignatureStatuses", [
          [o.signature],
          { searchTransactionHistory: true },
        ]);
        const st = status?.value?.[0];
        if (!st || st.confirmationStatus !== "finalized") continue;
        if (st.err) {
          this.s.tx(() => {
            o.state = "failed";
            this.s.saveOrder(o);
            this.s.event("FINALIZED_FAILURE", {
              id: o.id,
              signature: o.signature,
              error: st.err,
            });
          });
          continue;
        }
        const t = await this.p.rpc("getTransaction", [
          o.signature,
          {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
            commitment: "finalized",
          },
        ]);
        if (!t || t.meta.err) continue;
        const delta = new Map();
        for (const [field, sign] of [
          ["preTokenBalances", -1n],
          ["postTokenBalances", 1n],
        ])
          for (const b of t.meta[field] ?? [])
            if (b.owner === this.wallet)
              delta.set(
                b.mint,
                (delta.get(b.mint) ?? 0n) +
                  sign * BigInt(b.uiTokenAmount.amount),
              );
        const spent = -(delta.get(o.intent.inputMint) ?? 0n),
          received = delta.get(o.intent.outputMint) ?? 0n;
        if (
          spent !== BigInt(o.intent.amount) ||
          received < BigInt(o.quote.otherAmountThreshold)
        ) {
          this.s.set("killed", true);
          this.s.event("RECONCILIATION_MISMATCH", { id: o.id });
          continue;
        }
        this.s.tx(() => {
          const holdings = this.s.get("holdings", {}),
            buy = o.intent.inputMint === USDC,
            mint = buy ? o.intent.outputMint : o.intent.inputMint;
          let pnl = 0;
          if (buy) {
            const h = holdings[mint] ?? { raw: "0", costRaw: 0 };
            h.raw = (BigInt(h.raw) + received).toString();
            h.costRaw += Number(spent);
            holdings[mint] = h;
          } else {
            const h = holdings[mint];
            if (!h || BigInt(h.raw) < spent)
              throw Error("Tracked inventory mismatch");
            const cost = Math.round(
              (h.costRaw * Number(spent)) / Number(h.raw),
            );
            pnl = Number(received) - cost;
            h.raw = (BigInt(h.raw) - spent).toString();
            h.costRaw -= cost;
            if (h.raw === "0") delete holdings[mint];
            const day = "loss:" + new Date().toISOString().slice(0, 10);
            this.s.set(day, this.s.get(day, 0) + Math.max(0, -pnl));
          }
          this.s.set("holdings", holdings);
          o.state = "confirmed";
          o.result = {
            spent: spent.toString(),
            received: received.toString(),
            pnlUSDC: pnl / 1e6,
            networkFeeLamports: t.meta.fee,
            slot: t.slot,
          };
          delete o.signed;
          this.s.saveOrder(o);
          this.s.event("FINALIZED_FILL", {
            id: o.id,
            signature: o.signature,
            ...o.result,
          });
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
