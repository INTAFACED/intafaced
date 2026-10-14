// Test harness only. Mounts the whole customer App (real top bar, routes, registry) signed in as a made-up user.
// Every API call is answered by the Playwright test; no service is contacted.
import '../../shared/tokens.css';
import '../../shared/styles.css';
import '../../app/redesign.css';
import '../../app/shell.css';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider, useSession } from '../../features/session/session';
import { App } from '../../app/App';

// Fake sign-in for the test only: a made-up user id and token, never a real credential.
function SignedIn({ children }: { children: ReactNode }) {
  const { session, commit } = useSession();
  const signedIn = new URLSearchParams(location.search).get('signedOut') !== '1';
  useEffect(() => {
    if (!signedIn) return;
    commit({
      accessToken: 'harness-token',
      refreshToken: 'harness-refresh',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      userId: '00000000-0000-4000-8000-000000000001',
    });
  }, []);
  return signedIn && !session ? null : <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <SignedIn>
        <App />
      </SignedIn>
    </SessionProvider>
  </StrictMode>,
);
