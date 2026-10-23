// Push for this site (HM-notifications-02). Registered only after the person presses "Allow notifications on this
// device" in notification preferences. It shows a pushed notice and, when pressed, opens its room on this site. A link
// that resolves to any other origin is never opened: the notice opens the inbox instead.

/** The notice's own room on this site, or the inbox. */
function sameSite(href) {
  if (typeof href !== 'string' || !href.startsWith('/')) return '/notifications';
  try {
    const url = new URL(href, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : '/notifications';
  } catch {
    return '/notifications';
  }
}

self.addEventListener('push', (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    notice = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof notice.title === 'string' && notice.title ? notice.title : 'Notification';
  const body = typeof notice.body === 'string' ? notice.body : '';
  event.waitUntil(self.registration.showNotification(title, { body, data: { href: sameSite(notice.href) } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = sameSite(event.notification.data?.href);
  event.waitUntil(self.clients.openWindow(new URL(href, self.location.origin).href));
});
