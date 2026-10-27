// Test harness only. Mounts the Markets screen with the real theme and providers but without the app shell,
// signed in as a labelled fake user (add ?signedout=1 to stay signed out). Every API call is answered by the
// Playwright test (no service is contacted).
import '../../../../shared/styles.css';
import '../../../../features/public/public.css';
import '../../../../app/redesign.css';
import '../../../../app/shell.css';
import './harness-tokens.css';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HideBalancesProvider, TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../../features/session/session';
import Markets from '../index';

const signedOut = new URLSearchParams(location.search).has('signedout');

// Fake sign-in for the test only: a made-up user id and token, never a real credential.
function SignedIn({ children }: { children: ReactNode }) {
  const { session, commit } = useSession();
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <SignedIn>
        <HideBalancesProvider hidden={false}>
          <TooltipProvider>
            <div className="if-app">
              <nav data-testid="harness-bar" className="harness-bar" aria-label="Harness stand-in for the top bar">
                <a href="/home">intafaced</a>
                <a href="/home">Home</a>
                <a href="/money">Money</a>
                <a href="/trade" aria-current="page">
                  Trade
                </a>
                <a href="/pay">Pay</a>
                <a href="/more">More</a>
                <span>harness stand-in for the top bar</span>
              </nav>
              <main id="main">
                <Markets path="/trade" search={location.search} params={{}} />
              </main>
            </div>
          </TooltipProvider>
        </HideBalancesProvider>
      </SignedIn>
    </SessionProvider>
  </StrictMode>,
);
