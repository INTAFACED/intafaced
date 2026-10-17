import { EmptyState, Page } from '../shared/ui';
import { appCopy } from './app-copy';

/**
 * The address of the separate founder console for `path`, from the build's `VITE_TEAM_URL`, or undefined when it is not
 * set or is not a safe address (https, no sign-in details, no query or fragment; plain http only for a local dev server).
 */
export function teamConsoleHref(path: string, configured: string | undefined, dev = false): string | undefined {
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    const local = dev && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash)
      return undefined;
    return new URL(path.replace(/^\//, ''), `${url.href.replace(/\/$/, '')}/`).href;
  } catch {
    return undefined;
  }
}

/** `/ops` and `/platform`: this app has no operator tools, so the room says so and points founders at the console. */
export function TeamDesk({ href }: { href: string | undefined }) {
  const { t } = appCopy.useCopy();
  return (
    <div className="legacy-room">
      <Page title={t('Separate team desk')}>
        <p>
          <a className="text-link" href="/">
            ← {t('Back to home')}
          </a>
        </p>
        <p className="muted">
          {t(
            'Founders and operators work in a separate console with its own sign-in. This app has no operator tools, and nothing on this page shows or changes company data.',
          )}
        </p>
        <EmptyState
          title={t('Open the operator console')}
          action={
            href ? (
              <a className="button button--primary" href={href}>
                {t('Open Team')}
              </a>
            ) : undefined
          }
        >
          {href
            ? t('The team desk uses separate operator authentication.')
            : t('The Team deployment address is not configured. Ask your operator for the verified console address.')}
        </EmptyState>
      </Page>
    </div>
  );
}
