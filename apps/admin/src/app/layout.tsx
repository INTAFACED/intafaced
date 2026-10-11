import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import '@intafaced/ui/tokens.css';
import './globals.css';

/**
 * The approved founder design uses Inter, downloaded at build time and served
 * from our own origin. No runtime font request discloses operator activity.
 */
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--adm-font-body' });

export const metadata: Metadata = {
  title: 'INTAFACED · Operator Console',
  description: 'Kill-switches, launch sequence, jurisdiction matrix, ledger ops and mounted operator tools.',
  robots: { index: false, follow: false },
};

// Browser chrome follows the approved app-local graphite token.
export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#090A0B',
};

/**
 * Nothing in this console is cached or prerendered. The drop, the flag
 * overrides and the matrix are read on every request, because a stale
 * kill-switch board is worse than no board.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
