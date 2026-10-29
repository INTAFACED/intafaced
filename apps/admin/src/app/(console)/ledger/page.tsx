import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { LedgerOps } from '@/components/ledger-ops';
import { LedgerLookup } from '@/components/ledger-lookup';
import { LedgerDesk } from '@/components/ledger-desk';
import { ReconciliationControls } from '@/components/reconciliation-controls';
import { PayHaltsDesk } from '@/components/pay-halts-desk';
import { readConsoleStatus } from '@/lib/console-status';
import { readFreeze } from '@/lib/control-plane-client';
import { loadPayHalts } from '@/lib/pay-halts/server';
import { treasuryParked } from '@/lib/ledger/reconciliation-server';
import { ledgerQueryFromParams } from '@/lib/search/cross-search';

/**
 * Ledger operations (§4.2 / §14.6): the posting freeze, the ledger desk's list, address search and counts and the
 * transaction lookup (J-ops-console-03), the reconciliation
 * controls (J-ops-console-07), and the payments halts that stop one operation. `?txId=` or `?businessKey=` (the cross-desk
 * search's link back) opens the lookup on that query.
 *
 * Server-loads the real freeze state through `readFreeze()` — the same client `/api/ledger-freeze` uses — so the
 * first paint is svc-ledger's answer and not a default. This page previously rendered `operator-commands.ts` stubs
 * and seeded its posting indicator from the `ledger.posting` FLAG, which is a drop-clock default rather than the
 * state of the book: a console with no credential at all displayed a confident "ACCEPTING".
 *
 * `readFreeze()` never throws and never invents a state. Unconfigured and unreachable both arrive as `ok: false`
 * with a reason, and the view renders UNKNOWN. The payments halts are read as the signed-in founder and each part
 * of that read can fail on its own, shown as a failure and never as "nothing is halted".
 */
export default async function LedgerOpsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('ledger');
  const founder = await requireFounderPage();
  const status = readConsoleStatus();
  const initial = ledgerQueryFromParams(await searchParams);
  // The as-of is the moment svc-ledger answered, stamped here on the server where the read happens. Stamping it while the
  // component renders gave the server and the browser two different times (React error 418) and a time that was not the read.
  const [{ freeze: initialFreeze, readAt: initialReadAt }, halts] = await Promise.all([
    readFreeze().then((freeze) => ({ freeze, readAt: new Date().toISOString() })),
    loadPayHalts(founder),
  ]);
  return (
    <div className="adm-stack">
      <LedgerOps treasury={status.treasury} initialFreeze={initialFreeze} initialReadAt={initialReadAt} userId={founder.session.userId} />
      <LedgerDesk userId={founder.session.userId} />
      <LedgerLookup key={initial ? JSON.stringify(initial) : ''} initial={initial} />
      <ReconciliationControls treasuryParked={treasuryParked()} userId={founder.session.userId} />
      <PayHaltsDesk initial={halts} userId={founder.session.userId} />
      <p>
        <Link href="/restore">Joint restore</Link>
      </p>
      <p>
        <Link href="/ledger/alerts" data-testid="recon-alerts-link">
          Reconciliation alerts
        </Link>
      </p>
    </div>
  );
}
