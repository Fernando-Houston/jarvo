// Web Push enrollment: register the service worker, subscribe with the
// gateway's VAPID key, hand the subscription to the Worker. The gateway's
// nightly digest cron does the rest.

function gatewayHttpBase(): string {
  const ws = process.env.NEXT_PUBLIC_GATEWAY_URL || "ws://localhost:8787";
  return ws.replace(/^ws/, "http").replace(/\/+$/, "");
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(reg && (await reg.pushManager.getSubscription()));
}

function b64uToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
  const bin = atob(norm + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Full enrollment flow. Returns an error message to surface, or null on success. */
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return "This browser doesn't support notifications.";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications are blocked for this site.";

  const base = gatewayHttpBase();
  const vapidRes = await fetch(`${base}/push/vapid`).catch(() => null);
  if (!vapidRes?.ok) return "The gateway isn't set up for push yet.";
  const { publicKey } = (await vapidRes.json()) as { publicKey: string };

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uToBytes(publicKey).buffer as ArrayBuffer,
    }));

  const saved = await fetch(`${base}/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  }).catch(() => null);
  if (!saved?.ok) return "Couldn't register with the gateway — try again.";
  return null;
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch(`${gatewayHttpBase()}/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);
  await sub.unsubscribe();
}
