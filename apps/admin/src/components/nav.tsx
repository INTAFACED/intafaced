'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { MODULE_ROUTES, navNeeded, type ModuleId } from '@/lib/modules';

/**
 * `modules` is the server-resolved list of enabled module ids (ADMIN_MODULES);
 * omitted means all. The env var cannot be read in the browser, so the layout
 * passes it down. This only hides links; the middleware and routes enforce.
 */
export function Nav({ modules }: { modules?: readonly ModuleId[] }) {
  const pathname = usePathname();
  const ROUTES = modules ? MODULE_ROUTES.filter((route) => modules.includes(route.id)) : MODULE_ROUTES;
  const links = ROUTES.map((route) => {
    const active = route.href === '/' ? pathname === '/' : pathname.startsWith(route.href);
    return (
      <Link key={route.href} href={route.href} aria-current={active ? 'page' : undefined}>
        {route.label}
      </Link>
    );
  });
  // With a single module enabled there is nowhere to go, so the bar (and the phone's "Menu · CRM") stays out of the way.
  if (!navNeeded(ROUTES.length)) return null;
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
