import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyLearnerDesk } from '@/components/academy-learner-desk';
import { loadLearner } from '@/lib/academy/learners-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One learner (J-academy-14): profile, access, enrolments, notes, tags, progress and the audit of every staff change. */
export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  requireModulePage('academy-ops');
  const operator = await requireFounderPage();
  const { accountId } = await params;
  if (!UUID.test(accountId)) notFound();
  const userId = accountId.toLowerCase();
  return <AcademyLearnerDesk userId={userId} initial={await loadLearner(operator, userId)} />;
}
