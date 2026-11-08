import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DisputeQueue } from '@/components/card-disputes/desk';
import { readStateFilter } from '@/lib/card-disputes/model';
import { readDisputeQueue } from '@/lib/card-disputes/read';
import '@/components/desk.css';

/** Card disputes (J-bank-27 #1): the queue, filtered by state, each case one click away. */
export const dynamic = 'force-dynamic';

export default async function CardDisputesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  const state = readStateFilter((await searchParams).state);
  const read = await readDisputeQueue(founder, state);
  return (
    <main className="dk-stack">
      <DisputeQueue asOf={read.asOf} queue={read.queue} state={state} />
    </main>
  );
}
