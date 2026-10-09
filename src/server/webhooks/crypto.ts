import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { randomBase62 } from "../ids";

export const newWebhookSecret = () => `whsec_${randomBase62(32)}`;

// Endpoint secrets must be usable for signing, so they are encrypted at rest
// (AES-256-GCM, key from env) rather than hashed. Format: iv.tag.ciphertext (base64url).
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(stored: string): string {
  const [iv, tag, ct] = stored.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

const key = () => Buffer.from(env().WEBHOOK_SECRET_ENC_KEY, "hex");

/* ------------------------------------------------------------------ */
/* Signing. Header: Soundverse-Signature: t=<unix seconds>,v1=<hex>    */
/* v1 = HMAC-SHA256(secret, `${t}.${raw body}`)                        */
/* ------------------------------------------------------------------ */

export const SIGNATURE_HEADER = "Soundverse-Signature";
export const DEFAULT_TOLERANCE_SEC = 300;

export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

export class WebhookVerificationError extends Error {}

// What a customer runs on receipt (also in the docs and scripts/webhook-receiver.ts).
// The timestamp is inside the signature, so it can't be altered; rejecting old
// timestamps defeats replay of a captured payload. Within the window, the
// event `id` lets receivers drop duplicates.
export function verifyWebhook(
  secret: string,
  header: string | null,
  rawBody: string,
  { toleranceSec = DEFAULT_TOLERANCE_SEC, now = Math.floor(Date.now() / 1000) } = {},
): void {
  if (!header) throw new WebhookVerificationError("missing signature header");
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) throw new WebhookVerificationError("malformed signature header");
  if (Math.abs(now - t) > toleranceSec) throw new WebhookVerificationError("timestamp outside tolerance (replay?)");
  const expected = Buffer.from(signPayload(secret, rawBody, t).split("v1=")[1], "hex");
  const given = Buffer.from(parts.v1, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new WebhookVerificationError("signature mismatch");
  }
}
