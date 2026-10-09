import { describe, expect, it } from "vitest";
import { splitCharge } from "@/server/billing/ledger";
import { creditCost, periodBounds, periodOf } from "@/server/billing/pricing";
import { stableStringify } from "@/server/http/idempotency";

describe("creditCost", () => {
  it.each([
    ["royalty_free", 30, 1],
    ["royalty_free", 60, 1], // exactly one unit
    ["royalty_free", 61, 2], // each *started* 60s costs again
    ["sync", 30, 6],
    ["sync", 90, 12],
    ["full_ownership", 60, 14],
    ["full_ownership", 240, 56],
  ] as const)("%s for %ds = %d credits", (license, sec, credits) => {
    expect(creditCost(license, sec)).toBe(credits);
  });

  it("rejects non-positive or fractional durations", () => {
    expect(() => creditCost("sync", 0)).toThrow();
    expect(() => creditCost("sync", 1.5)).toThrow();
  });
});

describe("splitCharge", () => {
  const base = { monthlyCredits: 200, overageAllowed: false };
  it("fits in allowance", () => {
    expect(splitCharge({ ...base, cost: 6, allowanceUsed: 194 })).toEqual({ allowance: 6, overage: 0 });
  });
  it("hard stops when it doesn't fit and overage is off", () => {
    expect(splitCharge({ ...base, cost: 6, allowanceUsed: 195 })).toBeNull();
  });
  it("splits allowance and overage when overage is on", () => {
    expect(splitCharge({ ...base, overageAllowed: true, cost: 6, allowanceUsed: 197 })).toEqual({
      allowance: 3,
      overage: 3,
    });
  });
  it("treats usage above the allowance (after a downgrade) as zero remaining", () => {
    expect(splitCharge({ ...base, cost: 1, allowanceUsed: 1500 })).toBeNull();
    expect(splitCharge({ ...base, overageAllowed: true, cost: 1, allowanceUsed: 1500 })).toEqual({
      allowance: 0,
      overage: 1,
    });
  });
});

describe("periods", () => {
  it("uses UTC calendar months", () => {
    expect(periodOf(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(periodOf(new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
    expect(periodBounds("2026-12")).toEqual({
      start: new Date("2026-12-01T00:00:00Z"),
      end: new Date("2027-01-01T00:00:00Z"),
    });
  });
});

describe("stableStringify", () => {
  it("ignores key order", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }),
    );
  });
});
