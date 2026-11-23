import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CardholderPage } from '@/components/card-programme/desk';
import { readCardholder, readProgrammeFigures } from '@/lib/card-programme/read';
import '@/components/desk.css';

/** One cardholder (J-bank-26 #2, #5): status, screening, cards, and their card funds beside the partner's own figures. */
export const dynamic = 'force-dynamic';

export default async function CardholderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  const id = (await params).id;
  const [{ asOf, part }, figures] = await Promise.all([readCardholder(founder, id), readProgrammeFigures(founder)]);
  return (
    <main className="dk-stack">
      <CardholderPage asOf={asOf} part={part} figures={figures} />
    </main>
  );
}
