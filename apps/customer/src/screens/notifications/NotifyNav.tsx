import { centreCopy } from './centre-copy';

export type NotifyView = 'inbox' | 'settings' | 'delivery';

const LINKS: readonly { id: NotifyView; href: string; label: 'navInbox' | 'navPreferences' | 'navDelivery' }[] = [
  { id: 'inbox', href: '/notifications', label: 'navInbox' },
  { id: 'settings', href: '/notifications?view=settings', label: 'navPreferences' },
  { id: 'delivery', href: '/notifications?view=delivery', label: 'navDelivery' },
];

/** The three parts of the Notifications centre. The current one is marked for screen readers as well as by look. */
export function NotifyNav({ current }: { current: NotifyView }) {
  const copy = centreCopy.useCopy();
  return (
    <nav className="nf-nav" aria-label={copy.t('navLabel')}>
      {LINKS.map((link) => (
        <a key={link.id} href={link.href} aria-current={link.id === current ? 'page' : undefined} className="nf-nav__link">
          {copy.t(link.label)}
        </a>
      ))}
    </nav>
  );
}
