import { env } from "../env";
import type { KeyMode } from "../keys/secrets";
import { MockProvider } from "./mock";
import { ProviderError, type MusicProvider } from "./types";

export interface ModelRef {
  provider: string;
  model: string;
}

export const MOCK_MODEL: ModelRef = { provider: "mock", model: "mock-music-1" };
export const FAL_MODEL: ModelRef = { provider: "fal", model: "minimax-music" };

// Chosen once, at job creation, and stored on the job. The worker runs the
// stored model and never substitutes another: the license a customer buys
// depends on the model's terms, so a silent fallback could change their rights.
// Test keys always get the mock: they never call the paid model.
export function modelFor(mode: KeyMode): ModelRef {
  if (mode === "test") return MOCK_MODEL;
  return env().LIVE_PROVIDER === "fal" ? FAL_MODEL : MOCK_MODEL;
}

export type ProviderResolver = (provider: string) => MusicProvider;

// The worker resolves the provider *stored on the job*. An unknown name fails
// the job rather than falling back to something else.
export const defaultResolver: ProviderResolver = (provider) => {
  if (provider === "mock") return (mock ??= new MockProvider());
  throw new ProviderError("provider_rejected", `Provider "${provider}" is not available.`, false);
};
let mock: MockProvider | undefined;
