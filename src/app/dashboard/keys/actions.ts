"use server";
import { revalidatePath } from "next/cache";
import { requireDashboard } from "@/server/auth/session";
import { ApiError } from "@/server/errors";
import { createKey, revokeKey, rotateKey } from "@/server/keys/service";
import type { KeyMode } from "@/server/keys/secrets";

export type KeyActionResult =
  | { ok: true; secret?: string; prefix?: string; message: string }
  | { ok: false; message: string };

// Server actions are POST-only with Next's built-in Origin check (CSRF).
async function run(fn: () => Promise<KeyActionResult>): Promise<KeyActionResult> {
  try {
    const result = await fn();
    revalidatePath("/dashboard/keys");
    return result;
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function createKeyAction(input: {
  name: string;
  mode: KeyMode;
  scopes: string[];
}): Promise<KeyActionResult> {
  const ctx = await requireDashboard();
  return run(async () => {
    const { key, secret } = await createKey(
      { accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip, role: ctx.role },
      input,
    );
    return { ok: true, secret, prefix: key.prefix, message: "Key created." };
  });
}

export async function revokeKeyAction(keyId: string): Promise<KeyActionResult> {
  const ctx = await requireDashboard();
  return run(async () => {
    await revokeKey({ accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip, role: ctx.role }, keyId);
    return { ok: true, message: "Key revoked. It stops working immediately." };
  });
}

export async function rotateKeyAction(keyId: string, graceSec: number): Promise<KeyActionResult> {
  const ctx = await requireDashboard();
  return run(async () => {
    const { key, secret } = await rotateKey(
      { accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip, role: ctx.role },
      keyId,
      graceSec,
    );
    return {
      ok: true,
      secret,
      prefix: key.prefix,
      message:
        graceSec > 0
          ? `Rotated. The old key keeps working for ${Math.round(graceSec / 3600)}h.`
          : "Rotated. The old key stopped working immediately.",
    };
  });
}
