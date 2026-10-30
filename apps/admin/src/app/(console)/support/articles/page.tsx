import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { KbEditor } from '@/components/support-kb-editor';
import { loadKbAuthoring } from '@/lib/support/kb-authoring-server';

/** Help articles: write a draft, send it for review, approve another person's draft, publish. The first paint is svc-support's own answer, with its read time. */
export default async function SupportArticlesPage() {
  requireModulePage('support');
  const founder = await requireFounderPage();
  return <KbEditor initial={await loadKbAuthoring(founder, null)} />;
}
