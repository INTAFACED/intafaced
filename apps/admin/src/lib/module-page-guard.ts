import { notFound, redirect } from 'next/navigation';
import { firstEnabledHref, isModuleEnabled, type ModuleId } from './modules';

/**
 * Second half of the ADMIN_MODULES page gate. The middleware already redirects away from a disabled module's page, but it matches
 * on the request path; this runs inside the page itself, so a path the middleware did not recognise still cannot render a
 * disabled module. Same behaviour as the middleware: redirect to the first enabled module, or 404 when none is enabled.
 * Call it first, before loading any of the page's data.
 */
export function requireModulePage(id: ModuleId, env: Record<string, string | undefined> = process.env): void {
  if (isModuleEnabled(id, env)) return;
  const target = firstEnabledHref(env);
  if (target) redirect(target);
  notFound();
}
