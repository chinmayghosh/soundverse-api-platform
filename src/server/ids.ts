import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

// Prefixed, sortable public ids: gen_01J9..., req_01J9...
export const newId = (prefix: string) => `${prefix}_${ulid()}`;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Unbiased base62 string from CSPRNG bytes (rejection sampling).
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}
