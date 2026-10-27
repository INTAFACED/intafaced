// Test harness only. Mounts the REAL top bar (with the Simple / Pro switch) over Home, or over the Trade markets
// list with ?screen=trade, signed in as a labelled fake user. Every API call is answered by the Playwright test
// (no service is contacted). The preference decides which Home is drawn, exactly as in the app.
import '../../../shared/styles.css';
import '../../../features/public/public.css';
import '../../../app/redesign.css';
import '../../../app/shell.css';
import '../../../app/lit-look-styles';
import './harness-tokens.css';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HideBalancesProvider, TooltipProvider } from '@intafaced/ui';
import { SessionProvider, useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import { TopBar } from '../../../app/TopBar';
import Home from '../index';
import Markets from '../../trade/markets';

const screen = new URLSearchParams(location.search).get('screen') === 'trade' ? 'trade' : 'home';

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
  return (
    <HideBalancesProvider hidden={hideBalances}>
      <TooltipProvider>
        <div className="if-app">
          <TopBar door={screen === 'trade' ? 'Trade' : 'Home'} path={screen === 'trade' ? '/trade' : '/home'} onSignOut={() => undefined} />
          <main id="main">{screen === 'trade' ? <Markets path="/trade" search="" params={{}} /> : <Home />}</main>
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
