export interface GenerateRequest {
  jobId: string;
  model: string;
  prompt: string;
  durationSec: number;
  instrumental: boolean;
  signal: AbortSignal;
  // Set when a previous (crashed) attempt already submitted this job to the
  // provider. Providers with async APIs resume polling it instead of paying
  // for a second generation.
  providerRequestId: string | null;
  // Called as soon as the provider accepts the job, so the id is persisted
  // before we start waiting on it.
  onSubmitted: (providerRequestId: string) => Promise<void>;
}

export interface GenerateResult {
  audio: Uint8Array;
  contentType: string;
  format: string;
  durationSec: number;
}

export interface MusicProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

export type ProviderErrorCode = "provider_timeout" | "provider_error" | "provider_rejected";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    // Rejections (e.g. content policy) won't succeed on retry; outages might.
    readonly retryable = code !== "provider_rejected",
  ) {
    super(message);
  }
}
