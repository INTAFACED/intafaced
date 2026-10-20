import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifyDesk } from '@/components/notify-desk';
import { NotifyConfigDesk } from '@/components/notify-config';
import { loadNotify } from '@/lib/notify/server';
import { loadNotifyConfig } from '@/lib/notify/config-server';

/**
 * Notify delivery health: per-channel outcomes and failures from svc-notify, with the time they were read. Read-only. Below it, the channel and template settings, also read-only.
 * When the founder session lacks the operator read permission the desk says so instead of showing zeros.
 */
export default async function NotifyPage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  const [health, config] = await Promise.all([loadNotify(founder), loadNotifyConfig(founder)]);
  return (
    <>
      <NotifyDesk initial={health} />
      <NotifyConfigDesk view={config} />
    </>
  );
}
