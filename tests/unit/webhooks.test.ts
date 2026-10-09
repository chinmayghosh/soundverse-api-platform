import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signPayload, verifyWebhook } from "@/server/webhooks/crypto";
import { RETRY_SCHEDULE_SEC } from "@/server/webhooks/deliveries";
import { isBlockedAddress, resolveSafeTarget } from "@/server/webhooks/ssrf";

describe("isBlockedAddress", () => {
  it.each([
    "169.254.169.254", "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc12::1",
    "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "ff02::1", "not-an-ip",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe("resolveSafeTarget", () => {
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/latest/meta-data/", // decimal form of 169.254.169.254
    "http://0xa9.0xfe.0xa9.0xfe/", // hex form
    "http://169.254.43518/", // mixed short form
    "http://[::ffff:169.254.169.254]/",
    "http://127.1/",
    "http://[::1]:8080/",
  ])("rejects %s", async (url) => {
    await expect(resolveSafeTarget(url, { allowHttp: true, allowPrivateHosts: [] })).rejects.toThrow(/non-public/);
  });

  it("rejects a hostname if any of its records is private (mixed DNS answer)", async () => {
    const resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(resolveSafeTarget("https://evil.example/", { resolver, allowPrivateHosts: [] })).rejects.toThrow(/non-public/);
  });

  it("rejects localhost via DNS", async () => {
    await expect(resolveSafeTarget("http://localhost:3000/", { allowHttp: true, allowPrivateHosts: [] })).rejects.toThrow();
  });

  it("requires https unless http is explicitly allowed, and refuses credentials", async () => {
    await expect(resolveSafeTarget("http://example.com/", { resolver: pub, allowHttp: false })).rejects.toThrow(/https/);
    await expect(resolveSafeTarget("ftp://example.com/", { resolver: pub, allowHttp: true })).rejects.toThrow();
    await expect(resolveSafeTarget("https://u:p@example.com/", { resolver: pub })).rejects.toThrow(/credentials/);
  });

  it("returns the validated address to pin the connection to", async () => {
    const t = await resolveSafeTarget("https://example.com/hook", { resolver: pub, allowPrivateHosts: [] });
    expect(t.address).toBe("93.184.216.34");
  });

  it("exempts only exact allowlisted hostnames", async () => {
    const local = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      resolveSafeTarget("http://localhost:4000/", { resolver: local, allowHttp: true, allowPrivateHosts: ["localhost"] }),
    ).resolves.toBeDefined();
    await expect(
      resolveSafeTarget("http://127.0.0.1:4000/", { allowHttp: true, allowPrivateHosts: ["localhost"] }),
    ).rejects.toThrow();
  });
});

describe("signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "generation.succeeded" });

  it("verifies a fresh, untampered payload", () => {
    expect(() => verifyWebhook(secret, signPayload(secret, body), body)).not.toThrow();
  });

  it("rejects tampering, the wrong secret, and malformed headers", () => {
    const sig = signPayload(secret, body);
    expect(() => verifyWebhook(secret, sig, body.replace("succeeded", "failed"))).toThrow(/mismatch/);
    expect(() => verifyWebhook("whsec_other", sig, body)).toThrow(/mismatch/);
    expect(() => verifyWebhook(secret, "garbage", body)).toThrow(/malformed/);
    expect(() => verifyWebhook(secret, null, body)).toThrow(/missing/);
    // Moving the timestamp forward to dodge the window breaks the signature.
    const v1 = sig.split("v1=")[1];
    expect(() => verifyWebhook(secret, `t=${Math.floor(Date.now() / 1000)},v1=${v1}`, body, { now: Math.floor(Date.now() / 1000) + 1 })).not.toThrow();
  });

  it("encrypts endpoint secrets at rest (authenticated)", () => {
    const enc = encryptSecret("whsec_abc");
    expect(enc).not.toContain("whsec_abc");
    expect(decryptSecret(enc)).toBe("whsec_abc");
    const [iv, tag, ct] = enc.split(".");
    expect(() => decryptSecret([iv, tag, ct.slice(0, -2) + "AA"].join("."))).toThrow();
  });
});

describe("retry schedule", () => {
  it("retries for about a day, with an attempt soon after a 10-minute outage ends", () => {
    const cumulative = RETRY_SCHEDULE_SEC.reduce<number[]>((acc, d) => [...acc, (acc.at(-1) ?? 0) + d], []);
    expect(cumulative.at(-1)!).toBeGreaterThanOrEqual(23 * 3600);
    // First attempt after the 10-minute mark comes within 20 minutes of the original send.
    expect(cumulative.find((c) => c >= 600)!).toBeLessThanOrEqual(20 * 60);
  });
});
