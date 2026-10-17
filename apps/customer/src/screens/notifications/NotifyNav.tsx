import { alertsCopy } from './alerts-copy';
import { centreCopy } from './centre-copy';

export type NotifyView = 'inbox' | 'alerts' | 'settings' | 'delivery';

const LINKS: readonly { id: NotifyView; href: string; label: 'navInbox' | 'navAlerts' | 'navPreferences' | 'navDelivery' }[] = [
  { id: 'inbox', href: '/notifications', label: 'navInbox' },
  { id: 'alerts', href: '/notifications?view=alerts', label: 'navAlerts' },
  { id: 'settings', href: '/notifications?view=settings', label: 'navPreferences' },
  { id: 'delivery', href: '/notifications?view=delivery', label: 'navDelivery' },
];

/** The four parts of the Notifications centre. The current one is marked for screen readers as well as by look. */
export function NotifyNav({ current }: { current: NotifyView }) {
  const copy = centreCopy.useCopy();
  const alerts = alertsCopy.useCopy();
  return (
    <nav className="nf-nav" aria-label={copy.t('navLabel')}>
      {LINKS.map((link) => (
        <a key={link.id} href={link.href} aria-current={link.id === current ? 'page' : undefined} className="nf-nav__link">
          {link.label === 'navAlerts' ? alerts.t('navAlerts') : copy.t(link.label)}
        </a>
      ))}
    </nav>
  );
}
