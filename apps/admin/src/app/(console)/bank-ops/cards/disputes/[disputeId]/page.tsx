import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DisputeCaseView } from '@/components/card-disputes/desk';
import { isDisputeId } from '@/lib/card-disputes/model';
import { readDisputeCase } from '@/lib/card-disputes/read';
import '@/components/desk.css';

/** One card dispute (J-bank-27 #1 to #4): its timeline, evidence, representment, arbitration, the partner's credit and the decision. */
export const dynamic = 'force-dynamic';

export default async function CardDisputePage({ params }: { params: Promise<{ disputeId: string }> }) {
  requireModulePage('bank-ops');
  const { disputeId } = await params;
  if (!isDisputeId(disputeId)) notFound();
  const founder = await requireFounderPage();
  const read = await readDisputeCase(founder, disputeId.toLowerCase());
  return (
    <main className="dk-stack">
      <DisputeCaseView asOf={read.asOf} dispute={read.dispute} />
    </main>
  );
}
