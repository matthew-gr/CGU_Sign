// A small in-memory rate limiter for public endpoints (Meeting Finder links, OAuth registration, MCP). Per process:
// GR OS runs as one Railway service, so that's the whole site. A restart forgets the counts, which is fine for limits
// meant to stop scripted abuse, not to meter use.
const hits = new Map<string, number[]>();
let sweptAt = 0;

/** True when `key` has used up `max` requests in the last `windowMs`; otherwise records this one and returns false. */
export function limited(key: string, max: number, windowMs = 60_000, at = Date.now()) {
  if (at - sweptAt > 5 * 60_000) {
    for (const [k, list] of hits) if (!list.length || at - list[list.length - 1] > 10 * 60_000) hits.delete(k);
    sweptAt = at;
  }
  const list = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return true;
  }
  list.push(at);
  hits.set(key, list);
  return false;
}

/** The caller's IP behind Railway's proxy (first x-forwarded-for hop), or "local". */
export function clientIp(h: Headers) {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

export const tooMany = () => Response.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429, headers: { "Retry-After": "60" } });
