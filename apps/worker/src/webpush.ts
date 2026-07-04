// Web Push from a Worker, no dependencies: VAPID auth (RFC 8292) + payload
// encryption (RFC 8291, aes128gcm) on WebCrypto. The `web-push` npm package
// leans on Node https/crypto internals — this is the ~150-line subset we need.

export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type VapidConfig = {
  /** Uncompressed P-256 public point, base64url (what the browser subscribed with). */
  publicKey: string;
  /** PKCS8 private key, base64url. */
  privateKeyPkcs8: string;
  /** mailto: or https: contact, e.g. "mailto:contact@houstonlandguy.com". */
  subject: string;
};

const enc = new TextEncoder();

export function b64uToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
  const bin = atob(norm + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64u(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  lengthBytes: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, lengthBytes * 8)
  );
}

/** Short-lived ES256 JWT binding our sender identity to this push service. */
async function vapidJwt(endpoint: string, vapid: VapidConfig): Promise<string> {
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64u(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: vapid.subject,
      })
    )
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    b64uToBytes(vapid.privateKeyPkcs8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${bytesToB64u(sig)}`;
}

/** RFC 8291: ECDH against the browser's subscription keys → aes128gcm record. */
async function encryptPayload(sub: PushSubscription, plaintext: string): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(sub.keys.p256dh); // 65-byte uncompressed point
  const authSecret = b64uToBytes(sub.keys.auth); // 16-byte shared auth secret

  const asKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  // workers-types names ECDH's peer-key param `$public`; the runtime (and the
  // standard) want `public` — cast past the mismatch.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asKeys.privateKey,
      256
    )
  );
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer
  );

  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    32
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Single record: plaintext + 0x02 last-record delimiter, no padding.
  const record = concat(enc.encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record)
  );

  // aes128gcm header: salt(16) | record size(4) | key id length(1) | as_public(65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export type PushResult = { ok: boolean; status: number; gone: boolean };

/** Encrypt + deliver one notification. `gone` = subscription expired, delete it. */
export async function sendPush(
  sub: PushSubscription,
  payload: unknown,
  vapid: VapidConfig
): Promise<PushResult> {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const jwt = await vapidJwt(sub.endpoint, vapid);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      Urgency: "normal",
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body,
  });
  // Drain the body so the subrequest completes cleanly.
  await res.arrayBuffer().catch(() => undefined);
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
