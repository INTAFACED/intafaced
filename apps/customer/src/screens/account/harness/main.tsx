// Test harness only. Mounts the Account screen with the real theme and providers but without the app shell,
// signed in as a labelled fake user. Every API call is answered by the Playwright test (no service is contacted).
import '../../../shared/styles.css';
import '../../../features/public/public.css';
import '../../../app/redesign.css';
import '../../../app/shell.css';
import './harness-tokens.css';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HideBalancesProvider, TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useLocation } from '../../../app/location';
import Account from '../index';

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

function Page() {
  const { hideBalances } = usePreferences();
  const here = useLocation();
  const [path = '', query = ''] = here.split('?');
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        <div className="if-app">
          <nav data-testid="harness-bar" className="harness-bar" aria-label="Harness stand-in for the top bar">
            <a href="/home">intafaced</a>
            <a href="/home">Home</a>
            <a href="/money">Money</a>
            <a href="/trade">Trade</a>
            <a href="/pay">Pay</a>
            <a href="/more">More</a>
            <span>harness stand-in for the top bar</span>
          </nav>
          <main
            id="main"
            onClick={(event) => {
              const anchor = event.target instanceof Element ? event.target.closest('a') : null;
              if (!anchor || anchor.origin !== location.origin) return;
              event.preventDefault();
              history.pushState(null, '', anchor.pathname + anchor.search);
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}
          >
            <Account path={path} search={query ? `?${query}` : ''} params={{}} />
          </main>
        </div>
      </TooltipProvider>
    </HideBalancesProvider>
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
