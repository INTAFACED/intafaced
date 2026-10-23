// Push for this site (HM-notifications-02). Registered only after the person presses "Allow notifications on this
// device" in notification preferences. It shows a pushed notice and, when pressed, opens its room on this site. A link
// that leaves this site is never opened: the notice opens the inbox instead.
self.addEventListener('push', (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    notice = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof notice.title === 'string' && notice.title ? notice.title : 'Notification';
  const body = typeof notice.body === 'string' ? notice.body : '';
  const href =
    typeof notice.href === 'string' && notice.href.startsWith('/') && !notice.href.startsWith('//') ? notice.href : '/notifications';
  event.waitUntil(self.registration.showNotification(title, { body, data: { href } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = event.notification.data?.href ?? '/notifications';
  event.waitUntil(self.clients.openWindow(new URL(href, self.location.origin).href));
});
