// Test harness only. Mounts the Pay screen (by path) with the real theme and providers but without the app shell, signed
// in as a labelled fake user (add ?signedout=1 to stay signed out). Every API call is answered by the Playwright test:
// no service is contacted.
import '../../../shared/styles.css';
import '../../../features/public/public.css';
import '../../../app/redesign.css';
import '../../../app/shell.css';
import './harness-tokens.css';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HideBalancesProvider, ToastProvider, TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { useLocation } from '../../../app/location';
import Pay from '../index';

function SignedIn({ children }: { children: ReactNode }) {
  const { session, commit } = useSession();
  const signedOut = new URLSearchParams(location.search).has('signedout');
  useEffect(() => {
    if (signedOut) return;
    commit({
      accessToken: 'harness-token',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      userId: '00000000-0000-4000-8000-000000000001',
    });
  }, []);
  return session || signedOut ? <>{children}</> : null;
}

function Page() {
  const { hideBalances } = usePreferences();
  useLocation();
  const props = { path: location.pathname, search: location.search, params: {} };
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        <ToastProvider>
          <div className="if-app">
            <nav data-testid="harness-bar" className="harness-bar" aria-label="Harness stand-in for the top bar">
              <a href="/home">intafaced</a>
              <a href="/home">Home</a>
              <a href="/money">Money</a>
              <a href="/trade">Trade</a>
              <a href="/pay" aria-current="page">
                Pay
              </a>
              <a href="/more">More</a>
              <span>harness stand-in for the top bar</span>
            </nav>
            <main id="main">
              {location.pathname.startsWith('/elsewhere') ? <p data-testid="elsewhere">Elsewhere in the app</p> : <Pay {...props} />}
            </main>
          </div>
        </ToastProvider>
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
