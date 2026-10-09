import { auditLog } from "../db/schema";
import type { Db, Tx } from "../db/client";
import { newId } from "../ids";

export type AuditAction =
  | "key.created"
  | "key.rotated"
  | "key.revoked"
  | "plan.changed"
  | "webhook.created"
  | "webhook.deleted"
  | "member.invited"
  | "member.removed"
  | "invite.revoked";

export interface AuditEntry {
  accountId: string;
  actorUserId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

// Always called inside the same transaction as the change it records, so an
// action without its audit row (or the reverse) cannot be committed.
export async function writeAudit(tx: Tx | Db, entry: AuditEntry) {
  await tx.insert(auditLog).values({
    id: newId("aud"),
    accountId: entry.accountId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
  });
}
