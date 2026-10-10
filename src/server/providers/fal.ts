import { sleep } from "./mock";
import { ProviderError, type GenerateRequest, type GenerateResult, type MusicProvider } from "./types";

// fal.ai queue API for MiniMax Music v2.6:
//   POST queue.fal.run/<model>                       -> { request_id }
//   GET  queue.fal.run/<app>/requests/<id>/status    -> IN_QUEUE | IN_PROGRESS | COMPLETED
//   GET  queue.fal.run/<app>/requests/<id>           -> { audio: { url, ... } }
// The queue (not the blocking fal.run endpoint) lets a restarted worker
// resume polling a request that was already submitted and paid for.
export const FAL_MODEL_ID = "fal-ai/minimax-music/v2.6";
const FAL_APP_ID = "fal-ai/minimax-music"; // request URLs use the app id, not the subpath
const QUEUE = "https://queue.fal.run";
const MP3_BITRATE = 256_000;

type Fetch = typeof fetch;

export class FalProvider implements MusicProvider {
  readonly name = "fal";

  constructor(
    private readonly opts: {
      apiKey: string;
      fetch?: Fetch;
      pollMs?: number;
      // Called before every *new* paid submission; false = budget exhausted.
      reserveCall?: () => Promise<boolean>;
    },
  ) {}

  private get fetch(): Fetch {
    return this.opts.fetch ?? fetch;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let requestId = req.providerRequestId;
    if (!requestId) {
      if (this.opts.reserveCall && !(await this.opts.reserveCall())) {
        throw new ProviderError("provider_rejected", "Live model budget cap reached; no paid call was made.", false);
      }
      const submitted = await this.call<{ request_id: string }>(`${QUEUE}/${FAL_MODEL_ID}`, req.signal, {
        method: "POST",
        body: JSON.stringify(this.input(req)),
      });
      requestId = submitted.request_id;
      await req.onSubmitted(requestId);
    }

    const base = `${QUEUE}/${FAL_APP_ID}/requests/${requestId}`;
    for (;;) {
      const s = await this.call<{ status: string }>(`${base}/status`, req.signal);
      if (s.status === "COMPLETED") break;
      if (s.status !== "IN_QUEUE" && s.status !== "IN_PROGRESS") {
        throw new ProviderError("provider_error", `Unexpected provider status ${s.status}.`);
      }
      await sleep(this.opts.pollMs ?? 2000, req.signal);
    }

    const result = await this.call<{ audio?: { url?: string; content_type?: string } }>(base, req.signal);
    const url = result.audio?.url;
    if (!url) throw new ProviderError("provider_error", "Provider returned no audio.");
    const audioRes = await this.fetch(url, { signal: req.signal });
    if (!audioRes.ok) throw new ProviderError("provider_error", `Audio download failed (HTTP ${audioRes.status}).`);
    const audio = new Uint8Array(await audioRes.arrayBuffer());

    return {
      audio,
      contentType: "audio/mpeg",
      format: "mp3",
      // Estimated from size at the constant bitrate we request.
      durationSec: Math.round(((audio.length * 8) / MP3_BITRATE) * 100) / 100,
    };
  }

  // MiniMax v2.6 has no duration parameter: the target length goes into the
  // style prompt as a hint and the model decides. Billing uses the requested
  // duration either way (see DECISIONS.md).
  private input(req: GenerateRequest) {
    return {
      prompt: `${req.prompt.trim()}. Target length about ${req.durationSec} seconds.`,
      is_instrumental: req.instrumental,
      lyrics: "",
      // With vocals and no lyrics given, let the model write them from the prompt.
      lyrics_optimizer: !req.instrumental,
      // Numbers, not strings: the live API rejects "44100" (its docs show strings).
      audio_setting: { format: "mp3", sample_rate: 44100, bitrate: MP3_BITRATE },
    };
  }

  private async call<T>(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(url, {
        ...init,
        signal,
        headers: { Authorization: `Key ${this.opts.apiKey}`, "Content-Type": "application/json" },
      });
    } catch (e) {
      if (signal.aborted) throw e; // timeout / cancel: handled by the worker
      throw new ProviderError("provider_error", "Could not reach the music model.");
    }
    if (res.ok) return (await res.json()) as T;
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    // 4xx other than rate limiting = the request itself was refused (bad
    // input, content policy): retrying won't help. 429/5xx might.
    if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) {
      // Provider internals stay in our logs; customers get a clean message.
      console.error(`fal refused request: HTTP ${res.status} ${detail}`);
      throw new ProviderError("provider_rejected", "The music model refused this request (e.g. content policy or unsupported input).", false);
    }
    throw new ProviderError("provider_error", `Music model error (HTTP ${res.status}).`);
  }
}
