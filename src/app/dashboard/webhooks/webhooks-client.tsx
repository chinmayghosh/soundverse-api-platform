"use client";
import { useState, useTransition } from "react";
import { Button } from "@/app/ui";
import { createEndpointAction, deleteEndpointAction, type WebhookActionResult } from "./actions";

interface Endpoint {
  id: string;
  url: string;
  createdAt: string;
}
interface Delivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
}

const fmt = (iso: string) => iso.replace("T", " ").slice(0, 19);

export function WebhooksClient({ endpoints, deliveries }: { endpoints: Endpoint[]; deliveries: Delivery[] }) {
  const [result, setResult] = useState<WebhookActionResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <section className="space-y-6 text-sm">
      <h1 className="text-xl font-semibold">Webhooks</h1>
      <p className="text-neutral-500">
        We POST <code>generation.succeeded</code>, <code>generation.failed</code> and <code>generation.canceled</code> events,
        signed with <code>Soundverse-Signature</code>. Failed deliveries retry for about 24 hours.
      </p>

      {result && (
        <div className={`rounded border p-3 ${result.ok ? "border-green-600" : "border-red-600 text-red-600"}`}>
          <p>{result.message}</p>
          {result.ok && result.secret && (
            <>
              <p className="mt-2 font-medium">Signing secret. Copy it now; it will never be shown again.</p>
              <code className="mt-1 block break-all rounded bg-neutral-100 p-2 dark:bg-neutral-800">{result.secret}</code>
            </>
          )}
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const url = String(new FormData(e.currentTarget).get("url"));
          start(async () => setResult(await createEndpointAction(url)));
        }}
      >
        <label className="flex-1">
          <span className="block">Endpoint URL</span>
          <input
            name="url"
            required
            placeholder="https://example.com/webhooks/soundverse"
            className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          />
        </label>
        <Button type="submit" disabled={pending}>Add endpoint</Button>
      </form>

      <table className="w-full text-left">
        <thead className="text-neutral-500">
          <tr><th className="py-1 pr-4">URL</th><th className="pr-4">Id</th><th className="pr-4">Created</th><th /></tr>
        </thead>
        <tbody>
          {endpoints.length === 0 && <tr><td colSpan={4} className="py-2 text-neutral-500">No endpoints.</td></tr>}
          {endpoints.map((e) => (
            <tr key={e.id} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="py-1 pr-4 break-all">{e.url}</td>
              <td className="pr-4 font-mono text-xs">{e.id}</td>
              <td className="pr-4">{fmt(e.createdAt)}</td>
              <td>
                <Button
                  variant="danger"
                  disabled={pending}
                  onClick={() => confirm(`Delete ${e.url}?`) && start(async () => setResult(await deleteEndpointAction(e.id)))}
                >
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="overflow-x-auto">
        <h2 className="mb-2 font-medium">Recent deliveries</h2>
        <table className="w-full text-left">
          <thead className="text-neutral-500">
            <tr>{["Event", "Type", "Status", "Attempts", "Last response", "Next retry"].map((h) => <th key={h} className="py-1 pr-4">{h}</th>)}</tr>
          </thead>
          <tbody>
            {deliveries.length === 0 && <tr><td colSpan={6} className="py-2 text-neutral-500">No deliveries yet.</td></tr>}
            {deliveries.map((d) => (
              <tr key={d.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="py-1 pr-4 font-mono text-xs">{d.eventId}</td>
                <td className="pr-4">{d.eventType}</td>
                <td className="pr-4">{d.status}</td>
                <td className="pr-4">{d.attempts}</td>
                <td className="pr-4 text-xs">{d.lastStatusCode ?? d.lastError ?? "—"}</td>
                <td className="pr-4">{d.nextAttemptAt ? fmt(d.nextAttemptAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
