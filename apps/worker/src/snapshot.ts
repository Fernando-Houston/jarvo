// The Time Machine: monthly HCAD snapshots of every zip the pipeline
// touches. HCAD only publishes the CURRENT roll — value velocity, ownership
// churn, and exemption-style deltas only exist if somebody archives. Every
// month this runs, the dataset becomes something nobody else has.
//
// Storage: gzipped NDJSON parts in Workers KV under
//   snap:v1:<YYYY-MM>:<zip>:p<part>   (all 62 HCAD attribute fields, no geometry)
// KV is the free-tier stand-in — the key scheme is R2-ready, and the write
// path is behind SnapshotStore so enabling R2 is a one-line rebind.
//
// Execution: a Durable Object alarm chain. Each alarm invocation fetches at
// most PAGES_PER_RUN pages (1000 rows each, OBJECTID-keyset pagination) and
// writes one part — comfortably inside the per-invocation subrequest budget —
// then re-alarms until the month's queue is empty.

export type SnapshotStore = {
  put(key: string, value: ArrayBuffer, metadata?: Record<string, unknown>): Promise<void>;
  list(prefix: string): Promise<Array<{ name: string; metadata?: unknown }>>;
};

export function kvSnapshotStore(kv: KVNamespace): SnapshotStore {
  return {
    put: (key, value, metadata) => kv.put(key, value, { metadata }),
    list: async (prefix) => {
      const out: Array<{ name: string; metadata?: unknown }> = [];
      let cursor: string | undefined;
      do {
        const page = await kv.list({ prefix, cursor });
        out.push(...page.keys.map((k) => ({ name: k.name, metadata: k.metadata })));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return out;
    },
  };
}

export type SnapshotState = {
  month: string; // "2026-07"
  queue: string[]; // zips not yet started
  current: { zip: string; lastOid: number; part: number; rows: number } | null;
  done: Array<{ zip: string; rows: number; parts: number }>;
  startedAt: string;
  finishedAt: string | null;
  errors: string[];
};

const HCAD_PARCELS_URL =
  "https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query";
const PAGE_SIZE = 1000;
export const PAGES_PER_RUN = 10;

type Attrs = Record<string, unknown>;

async function fetchPage(zip: string, lastOid: number): Promise<Attrs[]> {
  const body = new URLSearchParams({
    where: `site_zip='${zip}' AND OBJECTID>${lastOid}`,
    outFields: "*",
    returnGeometry: "false",
    orderByFields: "OBJECTID ASC",
    resultRecordCount: String(PAGE_SIZE),
    f: "json",
  });
  const res = await fetch(HCAD_PARCELS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HCAD snapshot page failed: HTTP ${res.status}`);
  const json = (await res.json()) as { features?: Array<{ attributes: Attrs }>; error?: { message?: string } };
  if (json.error) throw new Error(`HCAD snapshot page failed: ${json.error.message ?? "unknown"}`);
  return (json.features ?? []).map((f) => f.attributes);
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/**
 * One alarm-run's worth of work. Mutates and returns the state; caller
 * persists it and re-alarms while `finishedAt` is null.
 */
export async function snapshotChunk(store: SnapshotStore, state: SnapshotState): Promise<SnapshotState> {
  if (!state.current) {
    const zip = state.queue.shift();
    if (!zip) {
      state.finishedAt = new Date().toISOString();
      return state;
    }
    state.current = { zip, lastOid: 0, part: 0, rows: 0 };
  }
  const cur = state.current;

  try {
    const lines: string[] = [];
    let pages = 0;
    let exhausted = false;
    while (pages < PAGES_PER_RUN) {
      const attrs = await fetchPage(cur.zip, cur.lastOid);
      pages++;
      for (const a of attrs) {
        lines.push(JSON.stringify(a));
        const oid = a["OBJECTID"];
        if (typeof oid === "number" && oid > cur.lastOid) cur.lastOid = oid;
      }
      if (attrs.length < PAGE_SIZE) {
        exhausted = true;
        break;
      }
    }
    if (lines.length) {
      const key = `snap:v1:${state.month}:${cur.zip}:p${cur.part}`;
      await store.put(key, await gzip(lines.join("\n")), {
        rows: lines.length,
        lastOid: cur.lastOid,
        at: new Date().toISOString(),
      });
      cur.rows += lines.length;
      cur.part++;
    }
    if (exhausted) {
      state.done.push({ zip: cur.zip, rows: cur.rows, parts: cur.part });
      state.current = null;
      // Fully drained AND nothing queued → this run finished the month.
      if (!state.queue.length) state.finishedAt = new Date().toISOString();
    }
  } catch (err) {
    // Skip the wounded zip rather than stalling the chain; the error is kept
    // on the state for the status endpoint.
    state.errors.push(`${cur.zip} p${cur.part}: ${err instanceof Error ? err.message : String(err)}`);
    state.done.push({ zip: cur.zip, rows: cur.rows, parts: cur.part });
    state.current = null;
    if (!state.queue.length) state.finishedAt = new Date().toISOString();
  }
  return state;
}

export function newSnapshotState(month: string, zips: string[]): SnapshotState {
  return {
    month,
    queue: [...new Set(zips)].sort(),
    current: null,
    done: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errors: [],
  };
}
