import { notFound } from 'next/navigation';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyQuizTrail } from '@/components/academy-quiz-trail';
import { loadQuizTrail } from '@/lib/academy/quiz-trail-server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One quiz's finished attempts and score changes (AC-quizzes-04): overrides with a reason, key fixes and rescores. */
export default async function Page({ params }: { params: Promise<{ itemId: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const { itemId } = await params;
  if (!UUID.test(itemId)) notFound();
  return <AcademyQuizTrail itemId={itemId} initial={await loadQuizTrail(founder, itemId)} />;
}
