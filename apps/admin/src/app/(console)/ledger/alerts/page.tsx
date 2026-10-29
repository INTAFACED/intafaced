import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AlertsRoom } from '@/components/recon-alerts/room';
import { cursorFrom, readAlertsRoom } from '@/lib/recon-alerts/read';
import '@/components/desk.css';

/** Reconciliation alerts and the periods' green state (OPS-reconciliation-03). Each part is read on its own and fails on its own. */
export const dynamic = 'force-dynamic';

export default async function ReconciliationAlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('ledger');
  const founder = await requireFounderPage();
  const room = await readAlertsRoom(founder, cursorFrom((await searchParams).after));
  return (
    <main className="dk-stack" data-testid="recon-alerts-page">
      <p>
        <Link href="/ledger">Ledger ops</Link>
      </p>
      <AlertsRoom room={room} />
    </main>
  );
}
