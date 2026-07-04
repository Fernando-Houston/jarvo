// Team-warm response cache: Workers KV behind the same globalThis bridge the
// digest store uses. The per-isolate LRUs die with each isolate — this makes
// a parcel the scout looked up an hour ago instant for the analyst too.
// In plain Node (dev) there's no KV and calls pass straight through; the
// in-process LRUs already cover that case.

type KvBridge = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

async function sha1hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Run `fn` through the shared KV cache. `kind` namespaces the key ("hcad",
 * "fema", "coh"); `rawKey` is hashed, so any length is fine. Cache failures
 * never fail the call — worst case it's just a live fetch.
 */
export async function kvCached<T>(
  kind: string,
  rawKey: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  const kv = (globalThis as { __hviKv?: KvBridge }).__hviKv;
  if (!kv) return fn();
  let key: string | null = null;
  try {
    key = `cache:${kind}:${await sha1hex(rawKey)}`;
    const hit = await kv.get(key);
    if (hit != null) return JSON.parse(hit) as T;
  } catch {
    /* cache read trouble — fall through to live */
  }
  const value = await fn();
  if (key != null) {
    try {
      // KV floor is 60s.
      await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
    } catch {
      /* cache write trouble — the caller still gets their data */
    }
  }
  return value;
}
