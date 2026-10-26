// Test harness only. Mounts the real top-bar bell and the Notifications screen with the real theme and providers but without
// the app shell, signed in as a labelled fake user. Every API call is answered by the Playwright test (no service is contacted).
// Other routes show a stand-in so a clicked notification visibly lands somewhere.
import '../../../shared/styles.css';
import '../../../features/public/public.css';
import '../../../app/redesign.css';
import '../../../app/shell.css';
import './harness-tokens.css';
import { StrictMode, useEffect, type MouseEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../features/session/session';
import { navigate, useLocation } from '../../../app/location';
import { BellPopover } from '../BellPopover';
import Notifications from '../index';

// Fake sign-in for the test only: a made-up user id and token, never a real credential.
function SignedIn({ children }: { children: ReactNode }) {
  const { session, commit } = useSession();
  useEffect(() => {
    commit({
      accessToken: 'harness-token',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      userId: '00000000-0000-4000-8000-000000000001',
    });
  }, []);
  return session ? <>{children}</> : null;
}

/** The app's own link handler (App.tsx followLink), so page links behave as in the real app. */
function follow(event: MouseEvent<HTMLDivElement>) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest('a') : null;
  if (!anchor) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
}

function Page() {
  const here = useLocation();
  const [path = '/', query = ''] = here.split('?');
  const search = query ? `?${query}` : '';
  return (
    <TooltipProvider>
      <div className="if-app" onClick={follow}>
        <header className="tb">
          <a className="tb-brand" href="/home">
            intafaced
          </a>
          <nav data-testid="tb-nav" className="tb-nav" aria-label="Harness stand-in for the top bar">
            <a href="/money">Money</a> <a href="/more">More</a>
          </nav>
          <div className="tb-right" style={{ marginLeft: 'auto' }}>
            <BellPopover path={path} />
          </div>
        </header>
        <main id="main">
          {path === '/notifications' ? (
            <Notifications path={path} search={search} params={{}} />
          ) : (
            <p data-testid="standin" style={{ padding: 32 }}>
              Stand-in page {path}
              {search}
            </p>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <SignedIn>
        <Page />
      </SignedIn>
    </SessionProvider>
  </StrictMode>,
);
