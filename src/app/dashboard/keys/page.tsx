import { requireDashboardWithPlan } from "@/server/auth/session";
import { SCOPES, listKeys } from "@/server/keys/service";
import { KeysClient } from "./keys-client";

export default async function KeysPage() {
  const ctx = await requireDashboardWithPlan();
  const keys = await listKeys(ctx.accountId);
  return (
    <KeysClient
      liveAllowed={ctx.plan.liveKeysAllowed}
      scopes={[...SCOPES]}
      keys={keys.map((k) => ({
        id: k.id,
        name: k.name,
        mode: k.mode,
        prefix: k.prefix,
        scopes: k.scopes,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        expiresAt: k.expiresAt?.toISOString() ?? null,
        status: k.status,
      }))}
    />
  );
}
