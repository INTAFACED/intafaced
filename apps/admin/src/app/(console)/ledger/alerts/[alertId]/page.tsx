import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AlertDetail } from '@/components/recon-alerts/room';
import { UUID } from '@/lib/recon-alerts/model';
import { readAlertDetail } from '@/lib/recon-alerts/read';
import { alertWritesParked, evidenceHash } from '@/lib/recon-alerts/treasury';
import '@/components/desk.css';

/**
 * One reconciliation alert: its evidence, acknowledgement, snoozes, notices and timeline (OPS-reconciliation-03), and its resolve
 * and two-founder accept (OPS-reconciliation-04). The evidence hash is computed here from svc-ops's own answer.
 */
export const dynamic = 'force-dynamic';

export default async function ReconciliationAlertPage({ params }: { params: Promise<{ alertId: string }> }) {
  requireModulePage('ledger');
  const founder = await requireFounderPage();
  const { alertId } = await params;
  if (!UUID.test(alertId)) notFound();
  const part = await readAlertDetail(founder, alertId.toLowerCase());
  return (
    <main className="dk-stack" data-testid="recon-alert-page">
      <p>
        <Link href="/ledger/alerts">Reconciliation alerts</Link>
      </p>
      <AlertDetail
        part={part}
        close={{
          founderId: founder.session.userId,
          evidenceHash: part.kind === 'ok' ? evidenceHash(part.data.alert) : null,
          writes: alertWritesParked(founder),
        }}
      />
    </main>
  );
}
