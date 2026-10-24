import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyGradingQueue } from '@/components/academy-grading-queue';
import { loadGradingQueue } from '@/lib/academy/grading-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One assignment's grading queue (AC-assignments-02): hand-ins under aliases, grade and comment, override with a reason. */
export default async function Page({ params }: { params: Promise<{ itemId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { itemId } = await params;
  if (!UUID.test(itemId)) notFound();
  return <AcademyGradingQueue itemId={itemId} initial={await loadGradingQueue(founder, itemId)} />;
}
