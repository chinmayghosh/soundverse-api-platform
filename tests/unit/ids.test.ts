import { describe, expect, it } from "vitest";
import { newId, randomBase62 } from "@/server/ids";

describe("ids", () => {
  it("prefixes ids", () => {
    expect(newId("gen")).toMatch(/^gen_[0-9A-Z]{26}$/);
  });
  it("produces base62 strings of the requested length", () => {
    const s = randomBase62(32);
    expect(s).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(randomBase62(32)).not.toBe(s);
  });
});
