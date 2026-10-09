import { requireDashboard } from "@/server/auth/session";
import { listGenerations } from "@/server/generations/queries";
import { serializeGeneration } from "@/server/generations/serialize";

export default async function GenerationsPage() {
  const ctx = await requireDashboard();
  const { rows } = await listGenerations(ctx.accountId, { limit: 50 });
  const gens = await Promise.all(rows.map((r) => serializeGeneration(r)));
  return (
    <section className="space-y-4 text-sm">
      <h1 className="text-xl font-semibold">Generations</h1>
      <p className="text-neutral-500">Latest 50. Audio links are signed and expire after an hour; reload for fresh ones.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-neutral-500">
            <tr>
              {["Created (UTC)", "Status", "Mode", "License", "Credits", "Model", "Prompt", "Result"].map((h) => (
                <th key={h} className="py-1 pr-4">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gens.length === 0 && (
              <tr><td colSpan={8} className="py-2 text-neutral-500">No generations yet.</td></tr>
            )}
            {gens.map((g) => (
              <tr key={g.id} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-2 pr-4 whitespace-nowrap">{g.created_at.replace("T", " ").slice(0, 19)}</td>
                <td className="pr-4">{g.status}</td>
                <td className="pr-4">{g.mode}</td>
                <td className="pr-4">{g.license}</td>
                <td className="pr-4">{g.credits_charged}</td>
                <td className="pr-4 text-xs">{g.model}</td>
                <td className="max-w-xs pr-4">{g.prompt}</td>
                <td className="pr-4">
                  {g.output?.audio_url ? (
                    <audio controls preload="none" src={g.output.audio_url} className="h-8 w-56" />
                  ) : g.error ? (
                    <span className="text-red-600">{g.error.code}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
