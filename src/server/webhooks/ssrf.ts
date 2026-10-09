import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { env } from "../env";

// Webhook URLs are attacker-controlled input that our servers will connect
// to. Every address a URL resolves to must be publicly routable; otherwise
// a customer could make us call 169.254.169.254 (cloud metadata), localhost,
// or anything on our private network.

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const lower = address.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:xxxx:xxxx) and NAT64 (64:ff9b::/96)
  // embed an IPv4 address that must pass the IPv4 rules.
  const embedded = embeddedIPv4(lower);
  if (embedded) return blocked.check(embedded, "ipv4");
  return blocked.check(lower, "ipv6");
}

function embeddedIPv4(v6: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v6);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2], 16);
  const lo = parseInt(m[3], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

export class UnsafeUrlError extends Error {}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: number;
}

// Parse, check scheme/credentials, resolve, and require *every* resolved
// address to be public (an attacker can return one public and one private
// record). Returns the address to connect to, so the delivery connects to
// exactly what was checked; re-run at every delivery to defeat DNS rebinding.
export async function resolveSafeTarget(
  raw: string,
  opts: { resolver?: Resolver; allowHttp?: boolean; allowPrivateHosts?: string[] } = {},
): Promise<ResolvedTarget> {
  const allowHttp = opts.allowHttp ?? env().ALLOW_HTTP_WEBHOOKS;
  const allowPrivate = opts.allowPrivateHosts ?? env().WEBHOOK_ALLOW_PRIVATE_HOSTS;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UnsafeUrlError(allowHttp ? "URL must use http or https" : "URL must use https");
  }
  if (url.username || url.password) throw new UnsafeUrlError("URL must not contain credentials");
  if (raw.length > 2048) throw new UnsafeUrlError("URL is too long");

  // WHATWG URL already normalized decimal/hex/short IPv4 forms
  // (http://2852039166/ -> 169.254.169.254) and bracketed IPv6.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await (opts.resolver ?? systemResolver)(host);
    } catch {
      throw new UnsafeUrlError(`could not resolve ${host}`);
    }
    if (addresses.length === 0) throw new UnsafeUrlError(`could not resolve ${host}`);
  }

  // Explicit, exact-hostname opt-out for local development (e.g. the demo
  // receiver container). Empty in production.
  const exempt = allowPrivate.includes(host.toLowerCase());
  if (!exempt) {
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) throw new UnsafeUrlError(`${host} resolves to a non-public address (${bad.address})`);
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}
