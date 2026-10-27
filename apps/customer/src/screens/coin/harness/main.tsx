// Test harness only. Mounts the Coin page at /coin/:asset with the real theme, the REAL top bar (so the coin bar's sticky
// offset is the real one) and providers, without the rest of the app shell, signed in as a labelled fake user (add
// ?signedout=1 to stay signed out). Every API call is answered by the Playwright test: no service is contacted.
import '../../../shared/styles.css';
import '../../../features/public/public.css';
import '../../../app/redesign.css';
import '../../../app/shell.css';
import './harness-tokens.css';
import { StrictMode, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HideBalancesProvider, ToastProvider, TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { TopBar } from '../../../app/TopBar';
import Coin from '../index';

// Fake sign-in for the test only: a made-up user id and token, never a real credential.
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

const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
};
const where = () => location.pathname + location.search;

function Page() {
  const { hideBalances } = usePreferences();
  const here = useSyncExternalStore(subscribe, where);
  const path = here.split('?')[0]!;
  const asset = /^\/coin\/([^/]+)/.exec(path)?.[1];
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        <ToastProvider>
          <div className="if-app">
            <TopBar door="Trade" path={path} onSignOut={() => undefined} />
            <main id="main">
              {asset !== undefined ? (
                <Coin path={path} search={here.slice(path.length)} params={{ asset: decodeURIComponent(asset) }} />
              ) : (
                <p data-testid="elsewhere" style={{ padding: 24 }}>
                  Harness stand-in for {path}
                </p>
              )}
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
