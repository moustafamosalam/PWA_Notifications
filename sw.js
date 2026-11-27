/* sw.js — receives Web Push and shows the notification */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { body: event.data ? event.data.text() : '' }; } catch (e2) { data = {}; }
  }
  const title = data.title || 'إشعار من السيرفر';
  const options = {
    body: data.body || '',
    icon: 'icon-180.png',
    badge: 'icon-180.png',
    dir: 'rtl',
    lang: 'ar',
    tag: data.tag || 'push',
    data: { url: './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
