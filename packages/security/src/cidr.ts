import { isIP } from "node:net";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

/** True if `ip` is inside any of the IPv4 CIDRs / exact IPs. IPv6 supports exact matches only. */
export function ipAllowed(ip: string | undefined, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  const addr = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  for (const entry of allowlist) {
    const [base, bitsRaw] = entry.split("/");
    if (!base) continue;
    if (isIP(addr) === 4 && isIP(base) === 4) {
      const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((ipv4ToInt(addr) & mask) === (ipv4ToInt(base) & mask)) return true;
    } else if (addr.toLowerCase() === base.toLowerCase()) return true;
  }
  return false;
}
