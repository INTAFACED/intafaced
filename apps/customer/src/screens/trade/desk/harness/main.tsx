// Test harness only. Mounts the Pro desk with the real theme and providers but without the app shell,
// signed in as a labelled fake user (add ?signedout=1 to stay signed out). Every API call is answered by the
// Playwright test (no service is contacted). The route comes from the address bar, like the real app, so a click
// on a market in the list changes the pair without a reload.
import '../../../../shared/styles.css';
import '../../../../features/public/public.css';
import '../../../../app/redesign.css';
import '../../../../app/shell.css';
import './harness-tokens.css';
import { Profiler, StrictMode, useEffect, type MouseEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HideBalancesProvider, TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../../features/session/session';
import { navigate, useLocation } from '../../../../app/location';
import { usePreferences } from '../../../../shared/preferences';
import Desk from '../index';

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

function Page() {
  const { hideBalances } = usePreferences();
  const current = useLocation();
  const path = current.split('?')[0] ?? '/';
  const search = current.slice(path.length);
  const pair = path.startsWith('/trade/spot/') ? decodeURIComponent(path.slice('/trade/spot/'.length)) : 'BTC-USDT';
  // The app shell follows same-origin links without a reload; the harness does the same.
  const follow = (event: MouseEvent<HTMLElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || event.defaultPrevented || event.button !== 0) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/trade/spot/')) return;
    event.preventDefault();
    navigate(url.pathname + url.search);
  };
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        <div className="if-app" onClick={follow}>
          <nav data-testid="harness-bar" className="harness-bar" aria-label="Harness stand-in for the top bar">
            <a href="/home">intafaced</a>
            <a href="/home">Home</a>
            <a href="/money">Money</a>
            <a href="/trade/spot/BTC-USDT" aria-current="page">
              Trade
            </a>
            <a href="/pay">Pay</a>
            <a href="/more">More</a>
            <span>harness stand-in for the top bar</span>
          </nav>
          <main id="main">
            <Profiler
              id="desk"
              onRender={(_id, phase, actualDuration) => {
                // Commit costs for the test to read (React Profiler, development build with StrictMode).
                ((window as unknown as { __commits?: Array<{ phase: string; ms: number }> }).__commits ??= []).push({
                  phase,
                  ms: actualDuration,
                });
              }}
            >
              <Desk path={path} search={search} params={{ pair }} />
            </Profiler>
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
