import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ServiceDeskView } from '@/components/bank-service/desk';
import { readServiceDesk } from '@/lib/bank-service/read';
import '@/components/desk.css';

/** Ramp metrics and direct debit mandates, as the partner reports them (J-bank-28 #3 #4). Read only. */
export const dynamic = 'force-dynamic';

export default async function BankServicePage() {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  return (
    <main className="dk-stack">
      <ServiceDeskView desk={await readServiceDesk(founder)} />
    </main>
  );
}
