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
        .then((clientList) => {
          // 既に開いているウィンドウがあれば postMessage でアプリ側に遷移を依頼してフォーカス
          // （PWAでは client.navigate が効かずURLが変わらないため、クライアント側 router.push に任せる）
          for (const client of clientList) {
            if ('focus' in client) {
              client.postMessage({ type: 'notification-navigate', url });
              return client.focus();
            }
          }
          // 開いていなければ新規ウィンドウで開く
          if (clients.openWindow) {
            return clients.openWindow(url);
          }
        }),
    ])
  );
});
