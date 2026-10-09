"use client";
import { useState, useTransition } from "react";
import { Button } from "@/app/ui";
import { inviteAction, removeMemberAction, revokeInviteAction, type TeamActionResult } from "./actions";

interface Props {
  isOwner: boolean;
  selfId: string;
  members: { userId: string; email: string; name: string; role: "owner" | "developer" }[];
  invites: { id: string; email: string; role: "owner" | "developer"; createdAt: string }[];
}

export function TeamClient({ isOwner, selfId, members, invites }: Props) {
  const [result, setResult] = useState<TeamActionResult | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<TeamActionResult>) => start(async () => setResult(await fn()));

  return (
    <section className="space-y-6 text-sm">
      <h1 className="text-xl font-semibold">Team</h1>
      <p className="text-neutral-500">
        <b>Owners</b> manage everything. <b>Developers</b> can view everything and manage <b>test</b> keys, but can&apos;t
        touch live keys, webhooks or the team.
      </p>

      {result && <p className={result.ok ? "text-green-700" : "text-red-600"}>{result.message}</p>}

      {isOwner && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            act(() => inviteAction(String(f.get("email")), f.get("role") as "owner" | "developer"));
          }}
        >
          <label>
            <span className="block">Email</span>
            <input name="email" type="email" required className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
          </label>
          <label>
            <span className="block">Role</span>
            <select name="role" className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700">
              <option value="developer">developer</option>
              <option value="owner">owner</option>
            </select>
          </label>
          <Button type="submit" disabled={pending}>Invite</Button>
        </form>
      )}

      <table className="w-full text-left">
        <thead className="text-neutral-500">
          <tr><th className="py-1 pr-4">Member</th><th className="pr-4">Role</th><th /></tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} className="border-t border-neutral-200 dark:border-neutral-800">
              <td className="py-1 pr-4">{m.name} · {m.email}{m.userId === selfId && " (you)"}</td>
              <td className="pr-4">{m.role}</td>
              <td>
                {isOwner && m.role === "developer" && (
                  <Button variant="danger" disabled={pending} onClick={() => act(() => removeMemberAction(m.userId))}>Remove</Button>
                )}
              </td>
            </tr>
          ))}
          {invites.map((i) => (
            <tr key={i.id} className="border-t border-neutral-200 text-neutral-500 dark:border-neutral-800">
              <td className="py-1 pr-4">{i.email} (invited)</td>
              <td className="pr-4">{i.role}</td>
              <td>
                {isOwner && (
                  <Button disabled={pending} onClick={() => act(() => revokeInviteAction(i.id))}>Revoke invite</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
