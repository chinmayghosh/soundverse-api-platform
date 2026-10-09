import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { writeAudit } from "../audit/log";
import { db } from "../db/client";
import { accounts, apiKeys, plans } from "../db/schema";
import { env } from "../env";
import { Errors } from "../errors";
import { newId } from "../ids";
import { generateKey, parseKey, secretMatches, type KeyMode } from "./secrets";

export const SCOPES = [
  "generations:read",
  "generations:write",
  "usage:read",
  "webhooks:manage",
] as const;
export type Scope = (typeof SCOPES)[number];

// Columns safe to return anywhere. secret_hash is deliberately absent.
const publicColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  mode: apiKeys.mode,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
  expiresAt: apiKeys.expiresAt,
  replacedByKeyId: apiKeys.replacedByKeyId,
};
export type PublicKey = {
  id: string;
  name: string;
  mode: KeyMode;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  replacedByKeyId: string | null;
};

interface Actor {
  accountId: string;
  userId: string | null;
  ip?: string | null;
  // Developers manage test keys only; owners (and system callers) everything.
  role?: "owner" | "developer";
}

function assertCanManage(actor: Actor, mode: KeyMode) {
  if (actor.role === "developer" && mode === "live") {
    throw Errors.forbidden("owner_only", "Only the account owner can manage live keys.");
  }
}

function validateScopes(scopes: string[]): Scope[] {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) throw Errors.invalidRequest("invalid_scopes", "At least one scope is required.");
  for (const s of unique) {
    if (!(SCOPES as readonly string[]).includes(s)) {
      throw Errors.invalidRequest("invalid_scopes", `Unknown scope "${s}".`);
    }
  }
  return unique as Scope[];
}

// Returns the full secret exactly once. Only its HMAC is stored.
export async function createKey(
  actor: Actor,
  input: { name: string; mode: KeyMode; scopes: string[] },
): Promise<{ key: PublicKey; secret: string }> {
  const name = input.name.trim().slice(0, 100) || "Untitled key";
  const scopes = validateScopes(input.scopes);
  assertCanManage(actor, input.mode);

  return db().transaction(async (tx) => {
    const [row] = await tx
      .select({ liveKeysAllowed: plans.liveKeysAllowed })
      .from(accounts)
      .innerJoin(plans, eq(plans.id, accounts.planId))
      .where(eq(accounts.id, actor.accountId));
    if (!row) throw Errors.notFound("account");
    if (input.mode === "live" && !row.liveKeysAllowed) {
      throw Errors.forbidden(
        "live_keys_not_in_plan",
        "Your plan only allows test keys. Upgrade to create live keys.",
      );
    }

    const { prefix, secret, secretHash } = generateKey(input.mode);
    const [key] = await tx
      .insert(apiKeys)
      .values({
        id: newId("key"),
        accountId: actor.accountId,
        name,
        mode: input.mode,
        prefix,
        secretHash,
        scopes,
        createdByUserId: actor.userId,
      })
      .returning(publicColumns);
    await writeAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: "key.created",
      targetType: "api_key",
      targetId: key.id,
      metadata: { prefix, mode: input.mode, scopes },
      ip: actor.ip,
    });
    return { key: key as PublicKey, secret };
  });
}

export type KeyStatus = "active" | "rotating" | "expired" | "revoked";

export function keyStatus(k: Pick<PublicKey, "revokedAt" | "expiresAt">, now = new Date()): KeyStatus {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && k.expiresAt <= now) return "expired";
  if (k.expiresAt) return "rotating";
  return "active";
}

export async function listKeys(accountId: string): Promise<(PublicKey & { status: KeyStatus })[]> {
  const rows = (await db()
    .select(publicColumns)
    .from(apiKeys)
    .where(eq(apiKeys.accountId, accountId))
    .orderBy(desc(apiKeys.createdAt))) as PublicKey[];
  const now = new Date();
  return rows.map((k) => ({ ...k, status: keyStatus(k, now) }));
}

export async function revokeKey(actor: Actor, keyId: string): Promise<PublicKey> {
  return db().transaction(async (tx) => {
    const [target] = await tx
      .select({ mode: apiKeys.mode })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, actor.accountId)));
    if (target) assertCanManage(actor, target.mode);
    const [key] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, actor.accountId), isNull(apiKeys.revokedAt)),
      )
      .returning(publicColumns);
    if (!key) throw Errors.notFound("active API key");
    await writeAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: "key.revoked",
      targetType: "api_key",
      targetId: key.id,
      metadata: { prefix: key.prefix },
      ip: actor.ip,
    });
    return key as PublicKey;
  });
}

// Zero-downtime rotation: a new key with the same mode and scopes is issued,
// and the old key keeps working until `expiresAt` (grace period), giving the
// customer time to deploy the new secret. graceSec = 0 cuts over immediately.
export async function rotateKey(
  actor: Actor,
  keyId: string,
  graceSec: number = env().KEY_ROTATION_GRACE_SEC,
): Promise<{ key: PublicKey; secret: string; previous: PublicKey }> {
  if (!Number.isInteger(graceSec) || graceSec < 0 || graceSec > 7 * 86400) {
    throw Errors.invalidRequest("invalid_grace_period", "Grace period must be 0 to 604800 seconds.");
  }
  return db().transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, actor.accountId)))
      .for("update");
    if (!old || old.revokedAt || (old.expiresAt && old.expiresAt <= new Date())) {
      throw Errors.notFound("active API key");
    }
    assertCanManage(actor, old.mode);
    // Rotating the same key twice would leave two "successors" alive.
    if (old.replacedByKeyId) {
      throw Errors.conflict("key_already_rotated", "This key was already rotated; rotate its replacement instead.");
    }

    const { prefix, secret, secretHash } = generateKey(old.mode);
    const [fresh] = await tx
      .insert(apiKeys)
      .values({
        id: newId("key"),
        accountId: actor.accountId,
        name: old.name,
        mode: old.mode,
        prefix,
        secretHash,
        scopes: old.scopes,
        createdByUserId: actor.userId,
      })
      .returning(publicColumns);
    const [previous] = await tx
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() + graceSec * 1000), replacedByKeyId: fresh.id })
      .where(eq(apiKeys.id, old.id))
      .returning(publicColumns);
    await writeAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: "key.rotated",
      targetType: "api_key",
      targetId: old.id,
      metadata: { oldPrefix: old.prefix, newKeyId: fresh.id, newPrefix: prefix, graceSec },
      ip: actor.ip,
    });
    return { key: fresh as PublicKey, secret, previous: previous as PublicKey };
  });
}

export interface AuthedKey {
  id: string;
  accountId: string;
  mode: KeyMode;
  scopes: string[];
}

// Runs on every API request. Deliberately uncached: a revoked key must fail on
// its very next request, and one indexed lookup by prefix is cheap.
export async function authenticate(authorization: string | null): Promise<AuthedKey> {
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    throw Errors.unauthenticated(
      "missing_api_key",
      "Provide your API key as `Authorization: Bearer <secret key>`.",
    );
  }
  const secret = match[1];
  const parsed = parseKey(secret);
  if (!parsed) throw Errors.unauthenticated("invalid_api_key", "Invalid API key.");

  const [key] = await db().select().from(apiKeys).where(eq(apiKeys.prefix, parsed.prefix));
  if (!key || !secretMatches(secret, key.secretHash)) {
    throw Errors.unauthenticated("invalid_api_key", "Invalid API key.");
  }
  if (key.revokedAt) throw Errors.unauthenticated("api_key_revoked", "This API key has been revoked.");
  if (key.expiresAt && key.expiresAt <= new Date()) {
    throw Errors.unauthenticated("api_key_expired", "This API key has expired (it was rotated).");
  }

  // Throttled so a busy key doesn't write on every request.
  await db()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, key.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - interval '30 seconds'`)),
      ),
    );

  return { id: key.id, accountId: key.accountId, mode: key.mode, scopes: key.scopes };
}
