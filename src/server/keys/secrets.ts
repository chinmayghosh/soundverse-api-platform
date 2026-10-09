import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { randomBase62 } from "../ids";

export type KeyMode = "test" | "live";

// sv_<mode>_<8 char lookup id>_<32 char secret>
// The first three parts form the public `prefix` (indexed, shown in the
// dashboard). The last part carries ~190 bits of entropy.
const KEY_RE = /^sv_(test|live)_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;

export function generateKey(mode: KeyMode) {
  const prefix = `sv_${mode}_${randomBase62(8)}`;
  const secret = `${prefix}_${randomBase62(32)}`;
  return { prefix, secret, secretHash: hashSecret(secret) };
}

export function parseKey(secret: string): { prefix: string; mode: KeyMode } | null {
  const m = KEY_RE.exec(secret);
  if (!m) return null;
  return { prefix: `sv_${m[1]}_${m[2]}`, mode: m[1] as KeyMode };
}

// HMAC with a server-side pepper rather than bcrypt: the secret is already
// high-entropy random (no dictionary to slow down), and auth runs on every
// request. A leaked DB without the pepper does not allow offline checks.
export function hashSecret(secret: string): string {
  return createHmac("sha256", env().API_KEY_PEPPER).update(secret).digest("hex");
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
