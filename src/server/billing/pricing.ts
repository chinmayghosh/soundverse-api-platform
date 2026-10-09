export const LICENSES = ["royalty_free", "sync", "full_ownership"] as const;
export type License = (typeof LICENSES)[number];

// Credits per started 60 seconds of requested audio.
export const LICENSE_CREDITS: Record<License, number> = {
  royalty_free: 1,
  sync: 6,
  full_ownership: 14,
};

export const SECONDS_PER_UNIT = 60;

// Billed on the *requested* duration, known up front, so the charge can be
// reserved atomically at creation. Models often return slightly longer audio
// (e.g. 31.84s for 30s); that never changes the price.
export function creditCost(license: License, durationSec: number): number {
  if (!Number.isInteger(durationSec) || durationSec <= 0) {
    throw new Error(`invalid duration ${durationSec}`);
  }
  return LICENSE_CREDITS[license] * Math.ceil(durationSec / SECONDS_PER_UNIT);
}

// Allowance periods are calendar months in UTC: "2026-10".
export function periodOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}
