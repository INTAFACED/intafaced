import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { RailsDeskView } from '@/components/bank-rails/desk';
import { readRailsDesk } from '@/lib/bank-rails/read';
import '@/components/desk.css';

/** The bank rails desk: salary by direct deposit, the network's records against the app's (J-bank-30 #8). Read only. */
export const dynamic = 'force-dynamic';

export default async function BankRailsPage() {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  return (
    <main className="dk-stack">
      <RailsDeskView desk={await readRailsDesk(founder)} />
    </main>
  );
}
