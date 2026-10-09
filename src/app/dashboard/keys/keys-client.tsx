"use client";
import { useState, useTransition } from "react";
import { Button } from "@/app/ui";
import {
  createKeyAction,
  revokeKeyAction,
  rotateKeyAction,
  type KeyActionResult,
} from "./actions";

export interface KeyRow {
  id: string;
  name: string;
  mode: "test" | "live";
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  status: "active" | "rotating" | "expired" | "revoked";
}

const fmt = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—");

export function KeysClient(props: { keys: KeyRow[]; scopes: string[]; liveAllowed: boolean }) {
  const [result, setResult] = useState<KeyActionResult | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<KeyActionResult>) => start(async () => setResult(await fn()));

  function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    act(() =>
      createKeyAction({
        name: String(f.get("name")),
        mode: f.get("mode") as "test" | "live",
        scopes: f.getAll("scopes").map(String),
      }),
    );
  }

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">API keys</h1>

      {result && (
        <div
          className={`rounded border p-3 text-sm ${result.ok ? "border-green-600" : "border-red-600 text-red-600"}`}
        >
          <p>{result.message}</p>
          {result.ok && result.secret && (
            <div className="mt-2">
              <p className="font-medium">Copy this secret now. It will never be shown again.</p>
              <code className="mt-1 block break-all rounded bg-neutral-100 p-2 dark:bg-neutral-800">
                {result.secret}
              </code>
              <Button className="mt-2" onClick={() => navigator.clipboard.writeText(result.secret!)}>
                Copy
              </Button>
            </div>
          )}
        </div>
      )}

      <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="block">Name</span>
          <input name="name" defaultValue="My key" className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
        </label>
        <label>
          <span className="block">Mode</span>
          <select name="mode" className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700">
            <option value="test">test (mock model, free)</option>
            <option value="live" disabled={!props.liveAllowed}>
              live{props.liveAllowed ? "" : " (upgrade plan)"}
            </option>
          </select>
        </label>
        <fieldset className="flex gap-2">
          {props.scopes.map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input type="checkbox" name="scopes" value={s} defaultChecked />
              {s}
            </label>
          ))}
        </fieldset>
        <Button type="submit" disabled={pending}>Create key</Button>
      </form>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-2 pr-3">Name</th>
              <th className="pr-3">Prefix</th>
              <th className="pr-3">Scopes</th>
              <th className="pr-3">Created</th>
              <th className="pr-3">Last used</th>
              <th className="pr-3">Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.keys.map((k) => (
              <tr key={k.id} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-2 pr-3">{k.name}</td>
                <td className="pr-3 font-mono">{k.prefix}…</td>
                <td className="pr-3 text-xs">{k.scopes.join(", ")}</td>
                <td className="pr-3">{fmt(k.createdAt)}</td>
                <td className="pr-3">{fmt(k.lastUsedAt)}</td>
                <td className="pr-3">
                  {k.status}
                  {k.status === "rotating" && <span className="block text-xs">until {fmt(k.expiresAt)}</span>}
                </td>
                <td className="space-x-1 whitespace-nowrap">
                  {k.status === "active" && (
                    <>
                      <Button disabled={pending} onClick={() => act(() => rotateKeyAction(k.id, 86400))}>
                        Rotate (24h overlap)
                      </Button>
                      <Button disabled={pending} onClick={() => act(() => rotateKeyAction(k.id, 0))}>
                        Rotate now
                      </Button>
                    </>
                  )}
                  {(k.status === "active" || k.status === "rotating") && (
                    <Button
                      variant="danger"
                      disabled={pending}
                      onClick={() => confirm(`Revoke ${k.prefix}? Requests using it fail immediately.`) && act(() => revokeKeyAction(k.id))}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {props.keys.length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-neutral-500">No keys yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
