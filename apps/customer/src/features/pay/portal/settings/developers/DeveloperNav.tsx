import { developersCopy as c } from './copy';
import { DEVELOPER_PAGES } from './pages';

const links = DEVELOPER_PAGES;

/** The developer pages live under Settings; this row moves between them. It wraps at phone width. */
export function DeveloperNav({ room }: { room: string }) {
  const { t } = c.useCopy();
  const here = room === 'developer-endpoint' ? 'developer-webhooks' : room;
  return (
    <nav className="pp-subnav" aria-label={t('navLabel')}>
      {links.map(([id, href, key]) => (
        <a key={id} className="text-link" href={href} aria-current={here === id ? 'page' : undefined}>
          {t(key)}
        </a>
      ))}
    </nav>
  );
}
