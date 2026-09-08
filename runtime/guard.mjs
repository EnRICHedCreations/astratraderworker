import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { USDC, TOKEN, ASSOCIATED, JUPITER } from "./config.mjs";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
export function positiveRaw(value) {
  if (
    typeof value !== "string" ||
    !/^\d{1,20}$/.test(value) ||
    BigInt(value) <= 0n ||
    BigInt(value) > 18446744073709551615n
  )
    throw Error("Invalid integer token amount");
  return BigInt(value);
}
export function validateQuote(q, intent, c, taker) {
  if (
    q.inputMint !== intent.inputMint ||
    q.outputMint !== intent.outputMint ||
    String(q.inAmount) !== intent.amount
  )
    throw Error("Quote intent mismatch");
  if (q.swapMode !== "ExactIn" || q.router !== "metis")
    throw Error("Unsupported swap route");
  if (q.taker !== taker) throw Error("Unexpected taker");
  if (
    !Number.isInteger(q.slippageBps) ||
    q.slippageBps > c.slippageBps ||
    q.slippageBps < 0
  )
    throw Error("Slippage exceeds policy");
  const out = positiveRaw(q.outAmount),
    min = positiveRaw(q.otherAmountThreshold);
  if (min < (out * BigInt(10000 - c.slippageBps)) / 10000n || min > out)
    throw Error("Invalid minimum output");
  if (!Number.isFinite(q.priceImpact) || Math.abs(q.priceImpact) > 1)
    throw Error("Price impact exceeds 1%");
  if (
    !q.transaction ||
    !q.requestId ||
    !Number.isSafeInteger(Number(q.lastValidBlockHeight))
  )
    throw Error("Incomplete executable quote");
  return { out, min };
}
export function ata(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(TOKEN).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ASSOCIATED),
  )[0].toBase58();
}
export async function validateTransaction(q, intent, c, wallet, p) {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(q.transaction, "base64"),
  );
  if (
    tx.message.header.numRequiredSignatures !== 1 ||
    tx.message.staticAccountKeys[0].toBase58() !== wallet
  )
    throw Error("Unexpected transaction signer/payer");
  const lookups = [];
  for (const l of tx.message.addressTableLookups ?? []) {
    const a = await p.connection.getAddressLookupTable(l.accountKey);
    if (!a.value) throw Error("Missing address lookup table");
    lookups.push(a.value);
  }
  const decoded = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: lookups,
  });
  let swaps = 0;
  for (const ix of decoded.instructions) {
    const program = ix.programId.toBase58();
    if (program === JUPITER) {
      swaps++;
      continue;
    }
    if (program === COMPUTE) {
      if (![2, 3].includes(ix.data[0]))
        throw Error("Unsupported compute instruction");
      continue;
    }
    if (program === ASSOCIATED) {
      const k = ix.keys.map((k) => k.pubkey.toBase58());
      if (
        ix.data.length > 1 ||
        ![0, 1].includes(ix.data[0] ?? 0) ||
        k[0] !== wallet ||
        k[2] !== wallet ||
        ![intent.inputMint, intent.outputMint].includes(k[3]) ||
        k[1] !== ata(wallet, k[3]) ||
        k[4] !== "11111111111111111111111111111111" ||
        k[5] !== TOKEN
      )
        throw Error("Unexpected associated-account instruction");
      continue;
    }
    throw Error("Disallowed transaction program");
  }
  if (swaps !== 1) throw Error("Expected exactly one Jupiter swap");
  const fee = await p.rpc("getFeeForMessage", [
    Buffer.from(tx.message.serialize()).toString("base64"),
    { commitment: "confirmed" },
  ]);
  if (
    !Number.isSafeInteger(fee.value) ||
    fee.value < 0 ||
    fee.value > c.maxLamports
  )
    throw Error("Transaction fee exceeds budget");
  const extended = await p.rpc("getTokenAccountsByOwner", [
    wallet,
    { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (extended.value.length)
    throw Error("Dedicated wallet must not contain Token-2022 accounts");
  const owned = await p.rpc("getTokenAccountsByOwner", [
    wallet,
    { programId: TOKEN },
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (owned.value.length > 60)
    throw Error("Too many token accounts to validate safely");
  const addresses = [
    wallet,
    ...new Set([
      ...owned.value.map((x) => x.pubkey),
      ata(wallet, intent.inputMint),
      ata(wallet, intent.outputMint),
    ]),
  ];
  const before = await p.rpc("getMultipleAccounts", [
    addresses,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (
    !before.value[0] ||
    before.value[0].lamports < c.minReserve + c.maxLamports
  )
    throw Error("Insufficient SOL reserve");
  const simulated = await p.rpc("simulateTransaction", [
    q.transaction,
    {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: before.context.slot,
      accounts: { encoding: "base64", addresses },
    },
  ]);
  if (simulated.value.err || !simulated.value.accounts)
    throw Error("Transaction simulation failed");
  validateSimulation(
    addresses,
    before.value,
    simulated.value.accounts,
    intent,
    c,
    wallet,
    BigInt(q.otherAmountThreshold),
  );
  return tx;
}
export function validateSimulation(
  addresses,
  before,
  after,
  intent,
  c,
  wallet,
  minOut,
) {
  if (
    after.length !== addresses.length ||
    !after[0] ||
    after[0].owner !== before[0].owner ||
    after[0].lamports < c.minReserve ||
    before[0].lamports - after[0].lamports > c.maxLamports
  )
    throw Error("Native balance policy failed");
  let spent = 0n,
    received = 0n;
  for (let i = 1; i < addresses.length; i++) {
    const old = before[i],
      next = after[i];
    if (!next) {
      if (old) throw Error("Token account closed by transaction");
      continue;
    }
    if (next.owner !== TOKEN) throw Error("Unexpected token account program");
    const b = Buffer.from(next.data[0], "base64");
    if (
      b.length !== 165 ||
      new PublicKey(b.subarray(32, 64)).toBase58() !== wallet
    )
      throw Error("Invalid token account owner/layout");
    const mint = new PublicKey(b.subarray(0, 32)).toBase58(),
      amount = b.readBigUInt64LE(64);
    let previous = 0n;
    if (old) {
      if (old.owner !== TOKEN)
        throw Error("Preexisting account program mismatch");
      const a = Buffer.from(old.data[0], "base64");
      if (
        a.length !== 165 ||
        !a.subarray(0, 64).equals(b.subarray(0, 64)) ||
        !a.subarray(72).equals(b.subarray(72))
      )
        throw Error("Token authority/delegate/state changed");
      previous = a.readBigUInt64LE(64);
    } else {
      if (
        addresses[i] !== ata(wallet, mint) ||
        b.readUInt32LE(72) !== 0 ||
        b.readUInt32LE(129) !== 0 ||
        b[108] !== 1
      )
        throw Error("Unsafe new token account");
    }
    const delta = amount - previous;
    if (mint === intent.inputMint) spent -= delta;
    else if (mint === intent.outputMint) received += delta;
    else if (delta !== 0n) throw Error("Unrelated asset changed");
  }
  if (spent !== positiveRaw(intent.amount) || received < minOut)
    throw Error("Simulated swap amounts violate intent");
  return { spent: spent.toString(), received: received.toString() };
}
export function validateIntent(i, c, wallet) {
  if (!i || typeof i.id !== "string" || !/^[-a-zA-Z0-9_:]{1,150}$/.test(i.id))
    throw Error("Invalid order id");
  if (!Number.isSafeInteger(i.at) || Math.abs(Date.now() - i.at) > 10000)
    throw Error("Expired intent");
  if (i.wallet !== wallet) throw Error("Wallet mismatch");
  positiveRaw(i.amount);
  for (const m of [i.inputMint, i.outputMint]) new PublicKey(m);
  if (
    i.inputMint === i.outputMint ||
    !(i.inputMint === USDC || i.outputMint === USDC)
  )
    throw Error("Only USDC-quoted trades supported");
  if (i.inputMint === USDC && BigInt(i.amount) > BigInt(c.maxOrder) * 1000000n)
    throw Error("Per-order spending limit");
  if (typeof i.signalId !== "string" || !i.signalId)
    throw Error("Missing signal provenance");
}
