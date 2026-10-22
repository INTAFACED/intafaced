import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { HoldsDesk } from '@/components/bank-holds/desk';
import { readHoldDesk } from '@/lib/bank-holds/read';
import '@/components/desk.css';

/** Global send holds: the queue, place, release, ask for information, link a reference, read the customer's file. */
export const dynamic = 'force-dynamic';

export default async function BankHoldsPage() {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  return (
    <main className="dk-stack">
      <HoldsDesk desk={await readHoldDesk(founder)} operatorId={founder.session.userId} />
    </main>
  );
}
