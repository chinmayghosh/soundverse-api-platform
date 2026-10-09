import type { generations } from "../db/schema";
import { presignGet } from "../storage/s3";

type Row = typeof generations.$inferSelect;

// Public representation. Signed audio URLs are minted fresh on every read so
// they always carry a full TTL and expire on their own.
export async function serializeGeneration(g: Row, opts: { withAudioUrl?: boolean } = {}) {
  let output = null;
  if (g.status === "succeeded" && g.outputKey) {
    const signed = opts.withAudioUrl === false ? null : await presignGet(g.outputKey);
    output = {
      audio_url: signed?.url ?? null,
      audio_url_expires_at: signed?.expiresAt.toISOString() ?? null,
      duration_sec: g.outputDurationSec === null ? null : Number(g.outputDurationSec),
      format: g.outputFormat,
    };
  }
  return {
    id: g.id,
    object: "generation",
    status: g.status,
    mode: g.mode,
    prompt: g.prompt,
    duration_sec: g.durationSec,
    license: g.license,
    instrumental: g.instrumental,
    metadata: g.metadata,
    credits_charged: g.creditsCharged,
    model: `${g.provider}/${g.model}`,
    output,
    error: g.errorCode ? { code: g.errorCode, message: g.errorMessage } : null,
    created_at: g.createdAt.toISOString(),
    started_at: g.startedAt?.toISOString() ?? null,
    completed_at: g.completedAt?.toISOString() ?? null,
  };
}
