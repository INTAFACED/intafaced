import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@intafaced/ui/tokens.css';
import './globals.css';
import { ConsoleStatusBanner } from '@/components/console-status-banner';
import { Nav } from '@/components/nav';
import { readConsoleStatus } from '@/lib/console-status';
import { dropLabel } from '@/lib/drops';
import { readOperatorEnv } from '@/lib/operator-env';

export const metadata: Metadata = {
  title: 'INTAFACED · Operator Console',
  description: 'Kill-switches, launch sequence, jurisdiction matrix, ledger ops and mounted operator tools.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#000000',
};

/**
 * Nothing in this console is cached or prerendered. The drop, the flag
 * overrides and the matrix are read on every request, because a stale
 * kill-switch board is worse than no board.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  const env = readOperatorEnv();
  // Read here, not on one page: whether this console can halt anything is a
  // property of the deployment, and an operator must meet it on whichever screen
  // they happened to open. See `components/console-status-banner.tsx`.
  const consoleStatus = readConsoleStatus();

  return (
    <html lang="en">
      <body className="adm-theme">
        <a className="adm-skip" href="#operator-workspace">
          Skip to operator workspace
        </a>
        <div className="adm-shell">
          <header className="adm-topbar">
            <span className="adm-brand">
              INTAFACED
              <small>Operator Console · Team</small>
            </span>

            <Nav />

            <span className="adm-topbar__spacer" />

            <span className="adm-envstrip">
              <span>
                <b>{env.appEnv}</b>
              </span>
              <span>
                Drop <b>{dropLabel(env.drop)}</b>
              </span>
            </span>
          </header>

          <div className="adm-access-notice" role="note">
            <span className="adm-access-notice__label">Operator access</span>
            <span>
              {consoleStatus.bffGated
                ? 'Deployment gate configured. Access requires an authenticated operator proxy; this desk has no personal SSO session.'
                : 'Deployment gate unavailable. Operator requests refuse until an authenticated proxy and ADMIN_BFF_SHARED_SECRET are configured.'}
            </span>
          </div>

          <ConsoleStatusBanner status={consoleStatus} />

          <main className="adm-main" id="operator-workspace" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
