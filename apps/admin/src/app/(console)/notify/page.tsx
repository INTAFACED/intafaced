import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifyDesk } from '@/components/notify-desk';
import { loadNotify } from '@/lib/notify/server';

/**
 * Notify delivery health: per-channel outcomes and failures from svc-notify, with the time they were read. Read-only.
 * When the founder session lacks the operator read permission the desk says so instead of showing zeros.
 */
export default async function NotifyPage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  return <NotifyDesk initial={await loadNotify(founder)} />;
}
