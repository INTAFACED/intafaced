import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { NotifyDesk } from '@/components/notify-desk';
import { NotifyConfigDesk } from '@/components/notify-config';
import { RecipientsPanel, type NotConnected } from '@/components/notify-recipients';
import { loadNotify } from '@/lib/notify/server';
import { loadNotifyConfig } from '@/lib/notify/config-server';
import { loadRecipients } from '@/lib/notify/recipients-server';

/**
 * Notify delivery health: per-channel outcomes and failures from svc-notify, with the time they were read. Read-only. Below it, the channel and template settings, also read-only.
 * When the founder session lacks the operator read permission the desk says so instead of showing zeros.
 */
export default async function NotifyPage() {
  requireModulePage('notify');
  const founder = await requireFounderPage();
  const [health, config, recipients] = await Promise.all([
    loadNotify(founder),
    loadNotifyConfig(founder),
    loadRecipients(founder, 'quarantined'),
  ]);
  const notConnected: Record<string, string> = {};
  if (config.channels.kind === 'ok') for (const c of config.channels.data) if (c.notConnected) notConnected[c.channel] = c.notConnected;
  return (
    <>
      <nav className="dk-row" aria-label="Notify desks">
        <Link href="/notify/status" className="adm-link">
          Status page desk
        </Link>
      </nav>
      <NotifyDesk initial={health} />
      <RecipientsPanel initial={recipients} notConnected={notConnected satisfies NotConnected} />
      <NotifyConfigDesk view={config} />
    </>
  );
}
