import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const UNKNOWN = "unknown";

function normalize(ip: string): string | null {
  const plain = ip.trim().replace(/^::ffff:/i, "");
  const version = isIP(plain);
  if (version === 0) return null;
  // One person usually holds a whole /64, so a limit per address would be easy to walk around.
  if (version === 6) {
    const [head = "", tail] = plain.split("::");
    const groups = head === "" ? [] : head.split(":");
    if (tail !== undefined) {
      const after = tail === "" ? [] : tail.split(":");
      groups.push(...Array<string>(Math.max(0, 8 - groups.length - after.length)).fill("0"));
      groups.push(...after);
    }
    return `${groups.slice(0, 4).join(":")}::/64`.toLowerCase();
  }
  return plain;
}

/**
 * The client's address. Each trusted proxy adds one entry to the right of X-Forwarded-For, so the
 * entry at this count from the right is the last one a trusted machine wrote. Anything to its left
 * came from the client, and is ignored. With no trusted proxy, the header is ignored entirely.
 */
export function clientIp(c: Context, trustedProxyHops: number): string {
  const socket = () => {
    try {
      return normalize(getConnInfo(c).remote.address ?? "") ?? UNKNOWN;
    } catch {
      // A test's in-memory request has no socket.
      return UNKNOWN;
    }
  };
  if (trustedProxyHops === 0) return socket();
  const entries = (c.req.header("x-forwarded-for") ?? "").split(",");
  const entry =
    entries.length >= trustedProxyHops ? entries[entries.length - trustedProxyHops] : "";
  return normalize(entry ?? "") ?? socket();
}
