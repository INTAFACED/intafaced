'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { MODULE_ROUTES, type ModuleId } from '@/lib/modules';

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
