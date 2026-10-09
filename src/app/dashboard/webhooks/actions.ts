"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { ApiError } from "@/server/errors";
import { createEndpoint, deleteEndpoint, validateWebhookUrl } from "@/server/webhooks/endpoints";

export type WebhookActionResult = { ok: true; secret?: string; message: string } | { ok: false; message: string };

export async function createEndpointAction(url: string): Promise<WebhookActionResult> {
  try {
    const ctx = await requireOwner();
    await validateWebhookUrl(url);
    const { secret } = await db().transaction((tx) =>
      createEndpoint(tx, { accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip }, { url }),
    );
    revalidatePath("/dashboard/webhooks");
    return { ok: true, secret, message: "Endpoint added." };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function deleteEndpointAction(id: string): Promise<WebhookActionResult> {
  try {
    const ctx = await requireOwner();
    await deleteEndpoint({ accountId: ctx.accountId, userId: ctx.user.id, ip: ctx.ip }, id);
    revalidatePath("/dashboard/webhooks");
    return { ok: true, message: "Endpoint deleted." };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, message: e.message };
    throw e;
  }
}
