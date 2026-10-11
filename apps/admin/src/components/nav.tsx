'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ROUTES = [
  { href: '/crm', label: 'CRM' },
  { href: '/accounts', label: 'Account controls' },
  { href: '/', label: 'Kill-switches' },
  { href: '/launch', label: 'Launch sequence' },
  { href: '/jurisdiction', label: 'Jurisdiction' },
  { href: '/ledger', label: 'Ledger ops' },
  { href: '/tools', label: 'Operator tools' },
] as const;

export function Nav() {
  const pathname = usePathname();
  const links = ROUTES.map((route) => {
    const active = route.href === '/' ? pathname === '/' : pathname.startsWith(route.href);
    return (
      <Link key={route.href} href={route.href} aria-current={active ? 'page' : undefined}>
        {route.label}
      </Link>
    );
  });
  const current = ROUTES.find((route) => (route.href === '/' ? pathname === '/' : pathname.startsWith(route.href)))?.label ?? 'Console';
  return (
    <>
      <nav className="adm-nav adm-nav--desktop" aria-label="Operator console">
        {links}
      </nav>
      <details className="adm-nav-mobile">
        <summary aria-label="Open operator console navigation">Menu · {current}</summary>
        <nav aria-label="Operator console">{links}</nav>
      </details>
    </>
  );
}
