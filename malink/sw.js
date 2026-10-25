// v9 makes the application shell independent from an origin-root deployment.
// Subsequent application builds are detected through static version.json.
const CACHE_NAME = "malink-shell-v9";
const PUSH_DEDUPE_CACHE = "malink-push-dedupe-v1";
const PUSH_DEDUPE_LIMIT = 256;
const SCOPE_URL = new URL(self.registration.scope);
const BASE_PATH = SCOPE_URL.pathname.endsWith("/")
  ? SCOPE_URL.pathname
  : `${SCOPE_URL.pathname}/`;
const scopedUrl = (path) => new URL(path, SCOPE_URL).href;
const APP_SHELL = [scopedUrl("./"), scopedUrl("manifest.webmanifest"), scopedUrl("favicon.svg")];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map(async (url) => {
          const response = await fetch(url, { cache: "reload" });
          if (!response.ok) {
            throw new Error(`Could not refresh the app shell: ${url}`);
          }
          await cache.put(url, response);
        }),
      ),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key !== PUSH_DEDUPE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  // The application shell owns only its own origin. Cross-origin Matrix
  // requests (including long polls and media) stay with the browser/SDK;
  // forwarding them here adds another response and cancellation boundary.
  if (requestUrl.origin !== self.location.origin) return;
  if (
    requestUrl.pathname.startsWith("/_matrix/") ||
    requestUrl.pathname === `${BASE_PATH}version.json`
  ) {
    // Same-origin Matrix /sync is a credentialed long poll and must never be
    // cached or replayed by the app shell worker. The static deployment version
    // is also authoritative and must
    // never fall back to a cached response; leaving these requests unhandled
    // sends them directly to the network.
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(scopedUrl("./"), copy));
          }
          return response;
        })
        .catch(() => caches.match(scopedUrl("./"))),
    );
    return;
  }

  if (requestUrl.pathname.startsWith(`${BASE_PATH}assets/`)) {
    // Asset names contain their content hash and are immutable. Prefer the
    // Cache API so a slow origin cannot hold a warm client on the crypto WASM
    // download before Matrix startup. A new release has new URLs and therefore
    // cannot be confused with an older cached binary.
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached ?? fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        }),
      ),
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(handleMalinkPush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data));
});

async function handleMalinkPush(event) {
  let payload;
  try { payload = event.data?.json(); } catch { return; }
  if (!payload || !validOpaqueId(payload.event_id) || !validOpaqueId(payload.room_id)) return;
  if (!await claimPushEvent(payload.event_id)) return;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) client.postMessage({ type: 'MALINK_PUSH_RECEIVED', payload });
  // userVisibleOnly requires a visible notification even if a window is open.
  await self.registration.showNotification('Malink has a new message', {
    body: 'Open Malink to synchronize and view the message.',
    icon: scopedUrl('favicon.svg'), badge: scopedUrl('favicon.svg'),
    tag: `malink-event-${payload.event_id}`, renotify: false,
    data: { type: 'matrix.event', roomId: payload.room_id, eventId: payload.event_id },
  });
}

async function claimPushEvent(eventId) {
  const cache = await caches.open(PUSH_DEDUPE_CACHE);
  const key = new URL(
    `/__malink_push_seen__/${encodeURIComponent(eventId)}`,
    self.location.origin,
  ).href;
  if (await cache.match(key)) return false;
  await cache.put(key, new Response("", {
    headers: { "x-malink-push-received-at": String(Date.now()) },
  }));
  const keys = await cache.keys();
  await Promise.all(
    keys.slice(0, Math.max(0, keys.length - PUSH_DEDUPE_LIMIT))
      .map((request) => cache.delete(request)),
  );
  return true;
}

async function openNotificationTarget(data) {
  if (!data || data.type !== 'matrix.event' || !validOpaqueId(data.roomId) || !validOpaqueId(data.eventId)) return;
  const route = scopedUrl('./');
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target = windows[0];
  if (target) { if ('navigate' in target) await target.navigate(route); await target.focus(); }
  else await self.clients.openWindow(route);
}

function validOpaqueId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
