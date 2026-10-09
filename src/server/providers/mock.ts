import { env } from "../env";
import { ProviderError, type GenerateRequest, type GenerateResult, type MusicProvider } from "./types";

// Deterministic stand-in for a real model: configurable latency and failure
// rate, and it returns a real, playable WAV (a short chord progression) so the
// whole pipeline - storage, signed URLs, webhooks - is exercised end to end.
export class MockProvider implements MusicProvider {
  readonly name = "mock";

  constructor(
    private readonly opts: { latencyMs?: number; failureRate?: number } = {},
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const latency = this.opts.latencyMs ?? env().MOCK_LATENCY_MS;
    const failureRate = this.opts.failureRate ?? env().MOCK_FAILURE_RATE;

    await req.onSubmitted(req.providerRequestId ?? `mock_${req.jobId}`);
    // Fail "halfway through" so timeouts and errors hit a job mid-flight.
    await sleep(latency / 2, req.signal);
    if (Math.random() < failureRate) {
      throw new ProviderError("provider_error", "Mock provider: simulated upstream failure.");
    }
    await sleep(latency / 2, req.signal);

    return {
      audio: synthWav(req.durationSec),
      contentType: "audio/wav",
      format: "wav",
      durationSec: req.durationSec,
    };
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// 8 kHz, 8-bit mono PCM keeps files small (8 KB per second).
function synthWav(seconds: number): Uint8Array {
  const rate = 8000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n, 40);
  // I - V - vi - IV in C, one chord per second.
  const chords = [
    [261.63, 329.63, 392.0],
    [196.0, 246.94, 293.66],
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const chord = chords[Math.floor(t) % chords.length];
    const env = Math.min(1, (t % 1) * 20) * (1 - (t % 1) * 0.6);
    const s = chord.reduce((acc, f) => acc + Math.sin(2 * Math.PI * f * t), 0) / chord.length;
    buf[44 + i] = 128 + Math.round(s * env * 90);
  }
  return new Uint8Array(buf);
}
