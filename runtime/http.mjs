import { timingSafeEqual } from "node:crypto";
export function authorized(req, secret) {
  const actual = req.headers.authorization ?? "",
    expected = "Bearer " + secret;
  return (
    secret.length >= 32 &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}
export async function body(req, limit = 1048576) {
  let size = 0,
    parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error("Payload too large");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
export function send(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}
export function safeMessage(error) {
  return String(error?.message ?? "Unexpected error")
    .replace(/https?:\/\/[^\s]+/g, "[provider URL redacted]")
    .replace(/(Bearer |api-key[=:]\s*)[^\s]+/gi, "$1[redacted]")
    .slice(0, 300);
}
export function log(event, data = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}
