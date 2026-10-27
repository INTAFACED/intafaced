// Push for this site (HM-notifications-02). Registered only after the person presses "Allow notifications on this
// device" in notification preferences. It shows a pushed notice and, when pressed, opens its room on this site. A link
// that resolves to any other origin is never opened: the notice opens the inbox instead.

/**
 * The notice's own room on this site as a whole URL, or the inbox. The checked URL itself is what is kept and opened: a
 * path such as "/..//evil.example" resolves to this site, but its pathname "//evil.example" would leave it if read again.
 */
function sameSite(href) {
  const inbox = new URL('/notifications', self.location.origin).href;
  if (typeof href !== 'string') return inbox;
  try {
    const url = new URL(href, self.location.origin);
    return url.origin === self.location.origin ? url.href : inbox;
  } catch {
    return inbox;
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
  // The brand's app icon, and its one-colour mark as the status-bar badge (packages/ui/brand, served under /brand/).
  const brand = { icon: '/brand/icon-192.png', badge: '/brand/badge-96.png' };
  event.waitUntil(self.registration.showNotification(title, { body, ...brand, data: { href: sameSite(notice.href) } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(sameSite(event.notification.data?.href)));
});
