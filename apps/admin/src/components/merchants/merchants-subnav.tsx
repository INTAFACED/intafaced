'use client';

import Link from 'next/link';
import { PageFinder } from '@/components/founder-ops/navigation';
import { usePathname } from 'next/navigation';

export const MERCHANT_SECTIONS = [
  { href: '/merchants', label: 'Dashboard', match: (p: string) => p === '/merchants' },
  {
    href: '/merchants/all',
    label: 'All merchants',
    match: (p: string) => p === '/merchants/all' || /^\/merchants\/[0-9a-f-]{36}/i.test(p),
  },
  { href: '/merchants/live', label: 'Live monitor', match: (p: string) => p === '/merchants/live' },
  { href: '/merchants/risk', label: 'Risk', match: (p: string) => p === '/merchants/risk' },
  { href: '/kyb', label: 'Operations', match: (p: string) => p === '/kyb' },
  { href: '/merchants/approvals', label: 'Approvals', match: (p: string) => p.startsWith('/merchants/approvals') },
  { href: '/merchants/registries/venues', label: 'Venues', match: (p: string) => p.startsWith('/merchants/registries/venues') },
  { href: '/merchants/registries/networks', label: 'Networks', match: (p: string) => p.startsWith('/merchants/registries/networks') },
  {
    href: '/merchants/registries/wallet-routes',
    label: 'Wallet routes',
    match: (p: string) => p.startsWith('/merchants/registries/wallet-routes'),
  },
  { href: '/merchants/categories', label: 'Categories', match: (p: string) => p.startsWith('/merchants/categories') },
  { href: '/merchants/treasury', label: 'Treasury and halts', match: (p: string) => p.startsWith('/merchants/treasury') },
] as const;

/** Second-level navigation for the Merchants module. Links only; the pages and BFF enforce access. */
export function MerchantsSubnav() {
  const pathname = usePathname() ?? '';
  return (
    <nav className="mp-subnav" aria-label="Merchants sections">
      <PageFinder />
      {MERCHANT_SECTIONS.map((section) => (
        <Link key={section.href} href={section.href} aria-current={section.match(pathname) ? 'page' : undefined}>
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
