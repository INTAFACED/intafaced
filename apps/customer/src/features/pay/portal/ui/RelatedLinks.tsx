import { uiCopy } from './copy';

/** Where this record leads: its payment, its settlement, its customer. Only links the page can actually follow. */
export function RelatedLinks({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  const { t } = uiCopy.useCopy();
  if (links.length === 0) return null;
  return (
    <nav className="pp-related" aria-label={t('related')}>
      <h3>{t('related')}</h3>
      <ul>
        {links.map((link) => (
          <li key={link.href}>
            <a className="text-link" href={link.href}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
