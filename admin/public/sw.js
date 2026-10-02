self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'SALOGIC', body: event.data.text() };
  }

  const title = data.title || 'SALOGIC';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    tag: data.tag || 'default',
    data: { url: data.url || '/messages' },
    vibrate: [200, 100, 200],
    requireInteraction: true,
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      navigator.setAppBadge && navigator.setAppBadge(1).catch(() => {}),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || '/messages';

  event.waitUntil(
    Promise.all([
      navigator.clearAppBadge && navigator.clearAppBadge().catch(() => {}),
      clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then(async (clientList) => {
          // Navigate an already-open app window to the target URL, then focus it.
          // (openWindow alone often only focuses a standalone PWA without navigating.)
          for (const client of clientList) {
            if ('focus' in client) {
              try { if ('navigate' in client) await client.navigate(url); } catch (e) { /* ignore */ }
              return client.focus();
            }
          }
          if (clients.openWindow) {
            return clients.openWindow(url);
          }
        }),
    ])
  );
});
