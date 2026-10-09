import type { License } from "../billing/pricing";
import { env } from "../env";
import type { KeyMode } from "../keys/secrets";
import { reserveProviderCall } from "./budget";
import { FalProvider } from "./fal";
import { MockProvider } from "./mock";
import { ProviderError, type MusicProvider } from "./types";

export interface ModelRef {
  provider: string;
  model: string;
  // Licenses we can legitimately sell for this model's output, given the
  // provider's terms. A plan may include a license the model can't back.
  licenses: readonly License[];
}

export const MOCK_MODEL: ModelRef = {
  provider: "mock",
  model: "mock-music-1",
  licenses: ["royalty_free", "sync", "full_ownership"], // our own synthetic audio
};

// fal lists MiniMax Music v2.6 as "Commercial use"; MiniMax's terms leave
// output ownership with the customer only "to the extent permitted by law",
// with no exclusivity or indemnity. Non-exclusive licenses are sellable;
// assigning full ownership is not something we can back. See DECISIONS.md.
export const FAL_MODEL: ModelRef = {
  provider: "fal",
  model: "minimax-music-v2.6",
  licenses: ["royalty_free", "sync"],
};

// Chosen once, at job creation, and stored on the job. The worker runs the
// stored model and never substitutes another: the license a customer buys
// depends on the model's terms, so a silent fallback could change their rights.
// Test keys always get the mock: they never call the paid model.
export function modelFor(mode: KeyMode): ModelRef {
  if (mode === "test") return MOCK_MODEL;
  return env().LIVE_PROVIDER === "fal" ? FAL_MODEL : MOCK_MODEL;
}

export type ProviderResolver = (provider: string) => MusicProvider;

// The worker resolves the provider *stored on the job*. An unknown or
// unconfigured provider fails the job rather than falling back to another.
export const defaultResolver: ProviderResolver = (provider) => {
  if (provider === "mock") return (mock ??= new MockProvider());
  if (provider === "fal") {
    const apiKey = env().FAL_KEY;
    if (!apiKey) throw new ProviderError("provider_rejected", "The live music model is not configured.", false);
    return (fal ??= new FalProvider({ apiKey, reserveCall: () => reserveProviderCall("fal") }));
  }
  throw new ProviderError("provider_rejected", `Provider "${provider}" is not available.`, false);
};
let mock: MockProvider | undefined;
let fal: FalProvider | undefined;
