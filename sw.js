// The service worker: the part of the page that wakes up when the phone gets a turn alert, even with the
// game closed. It shows the alert, and tapping it brings the game to the front. It holds nothing private
// and never touches the network: the server sends the text of each alert, encrypted for this device.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const text = (value, fallback) => (typeof value === 'string' && value.length <= 200 ? value : fallback);

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {}; // not JSON: show the default alert
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/';
  // Every push must show something (the browsers insist), so a message we cannot read still says it is your turn.
  event.waitUntil(
    self.registration.showNotification(text(data.title, 'Big Two'), {
      body: text(data.body, "It's your turn."),
      tag: text(data.tag, 'turn'),
      renotify: true, // a second alert with the same tag still buzzes
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if ('focus' in w) return w.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
