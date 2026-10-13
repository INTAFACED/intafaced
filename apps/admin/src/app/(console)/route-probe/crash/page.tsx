import { requireFounderPage } from '@/lib/founder-page';
import { notFound } from 'next/navigation';

/**
 * Fail-closed render-error probe for `scripts/route-boundaries-harness.mjs`.
 *
 * Unset `ADMIN_ROUTE_PROBE` (every real compose) → not-found. The harness is
 * the only process that sets it, so this path never mounts a queue.
 */
export default async function RouteProbeCrashPage(): Promise<never> {
  await requireFounderPage();
  if (process.env.ADMIN_ROUTE_PROBE !== '1') {
    notFound();
  }
  throw new Error('admin.route_probe.render_error');
}
