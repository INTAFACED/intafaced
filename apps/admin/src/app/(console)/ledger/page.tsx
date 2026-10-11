import { requireFounderPage } from '@/lib/founder-page';
import { LedgerOps } from '@/components/ledger-ops';
import { readConsoleStatus } from '@/lib/console-status';
import { readFreeze } from '@/lib/control-plane-client';

/**
 * Ledger operations (§4.2 / §14.6).
 *
 * Server-loads the real freeze state through `readFreeze()` — the same client
 * `/api/ledger-freeze` uses — so the first paint is svc-ledger's answer and not
 * a default. This page previously rendered `operator-commands.ts` stubs and
 * seeded its posting indicator from the `ledger.posting` FLAG, which is a
 * drop-clock default rather than the state of the book: a console with no
 * credential at all displayed a confident "ACCEPTING".
 *
 * `readFreeze()` never throws and never invents a state. Unconfigured and
 * unreachable both arrive as `ok: false` with a reason, and the view renders
 * UNKNOWN.
 */
export default async function LedgerOpsPage() {
  await requireFounderPage();
  const status = readConsoleStatus();
  const initialFreeze = await readFreeze();
  return <LedgerOps treasury={status.treasury} initialFreeze={initialFreeze} />;
}
