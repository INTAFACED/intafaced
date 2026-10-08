'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ROUTES = [
  { href: '/', label: 'Kill-switches' },
  { href: '/launch', label: 'Launch sequence' },
  { href: '/jurisdiction', label: 'Jurisdiction' },
  { href: '/ledger', label: 'Ledger ops' },
  { href: '/tools', label: 'Operator tools' },
  { href: '/ops', label: 'Business operations' },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="adm-nav" aria-label="Operator console">
      {ROUTES.map((route) => {
        const active = route.href === '/' ? pathname === '/' : pathname.startsWith(route.href);
        return (
          <Link key={route.href} href={route.href} aria-current={active ? 'page' : undefined}>
            {route.label}
          </Link>
        );
      })}
    </nav>
  );
}
