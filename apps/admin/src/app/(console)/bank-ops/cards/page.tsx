import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CardProgrammeDesk } from '@/components/card-programme/desk';
import { readDesk, searchCardholders } from '@/lib/card-programme/read';
import '@/components/desk.css';

/** The card programme (J-bank-26): checklist, configuration, rules, 3DS, cardholders, the decision log, report, staff, bulk issue. */
export const dynamic = 'force-dynamic';

export default async function CardProgrammePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  const raw = (await searchParams).q;
  const query = (typeof raw === 'string' ? raw : '').trim().slice(0, 120);
  const [{ asOf, desk }, search] = await Promise.all([
    readDesk(founder),
    query ? searchCardholders(founder, query) : Promise.resolve(null),
  ]);
  return (
    <main className="dk-stack">
      <CardProgrammeDesk asOf={asOf} desk={desk} query={query} search={search} />
    </main>
  );
}
