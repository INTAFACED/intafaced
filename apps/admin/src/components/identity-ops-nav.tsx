'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const DESKS = [
  { href: '/identity-ops/keys', label: 'Signing keys' },
  { href: '/identity-ops/oauth', label: 'OAuth apps' },
  { href: '/changes/policy', label: 'Approval policy' },
] as const;

/** The identity desks share one entry in the console bar; this row moves between them. */
export function IdentityOpsNav() {
  const pathname = usePathname();
  return (
    <nav className="dk-row" aria-label="Identity desks" data-testid="identity-ops-nav">
      {DESKS.map((desk) => (
        <Link key={desk.href} href={desk.href} className="adm-btn" aria-current={pathname.startsWith(desk.href) ? 'page' : undefined}>
          {desk.label}
        </Link>
      ))}
    </nav>
  );
}
