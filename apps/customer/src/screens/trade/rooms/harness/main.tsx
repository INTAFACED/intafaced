// Test harness only. Mounts one trade room (?room=options|execution|otc) with the real theme and providers but without
// the app shell, signed in as a labelled fake user (add &signedout=1 to stay signed out). Every API call is answered by
// the Playwright test (no service is contacted). The path and search come from the address bar, like the real app.
import '../../../../shared/styles.css';
import '../../../../features/public/public.css';
import '../../../../app/redesign.css';
import '../../../../app/shell.css';
import './harness-tokens.css';
import { StrictMode, useEffect, type ComponentType, type MouseEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HideBalancesProvider, TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../../features/session/session';
import { navigate, useLocation } from '../../../../app/location';
import { usePreferences } from '../../../../shared/preferences';
import type { ScreenProps } from '../../../../app/screen-types';
import Options from '../../options/index';
import Execution from '../../execution/index';
import Otc from '../../otc/index';

const ROOMS: Record<string, ComponentType<ScreenProps>> = { options: Options, execution: Execution, otc: Otc };
const HREF_TO_ROOM: Record<string, string> = { '/trade/options': 'options', '/execution': 'execution', '/otc': 'otc' };
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
  const name = new URLSearchParams(search).get('room') ?? '';
  const Room = ROOMS[name];
  // The mode strip links to the real routes; the harness keeps the page and switches the room instead.
  const follow = (event: MouseEvent<HTMLElement>) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || event.defaultPrevented || event.button !== 0) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin) return;
    const room = HREF_TO_ROOM[url.pathname];
    event.preventDefault();
    if (room) navigate(`/?room=${room}`);
  };
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        <div className="if-app" onClick={follow}>
          <nav data-testid="harness-bar" className="harness-bar" aria-label="Harness stand-in for the top bar">
            <a href="/home">intafaced</a>
            <a href="/home">Home</a>
            <a href="/money">Money</a>
            <a href="/trade/options" aria-current="page">
              Trade
            </a>
            <a href="/pay">Pay</a>
            <a href="/more">More</a>
            <span className="harness-test" role="status">
              TEST DATA — not real money. Every figure here is a labelled stand-in.
            </span>
            <span>harness stand-in for the top bar</span>
          </nav>
          <main id="main">
            {Room ? <Room path={path} search={search} params={{}} /> : <p>Unknown room. Use ?room=options|execution|otc</p>}
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
