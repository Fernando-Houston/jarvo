// Jarvo service worker: receive nightly-digest pushes, open the app on tap.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON push — show something rather than nothing */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Jarvo", {
      body: data.body || "Something moved in Harris County.",
      tag: data.tag || "jarvo",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => "focus" in c);
      return open ? open.focus() : clients.openWindow(event.notification.data?.url || "/");
    })
  );
});
