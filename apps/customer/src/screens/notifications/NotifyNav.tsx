import { Tabs } from '@intafaced/ui/lit/templates';
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
    <Tabs
      label={copy.t('navLabel')}
      current={LINKS.find((link) => link.id === current)?.href ?? '/notifications'}
      items={LINKS.map((link) => ({
        href: link.href,
        label: link.label === 'navAlerts' ? alerts.t('navAlerts') : copy.t(link.label),
      }))}
    />
  );
}
