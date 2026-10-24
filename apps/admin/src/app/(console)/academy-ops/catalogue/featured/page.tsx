import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyLearnHub } from '@/components/academy-learn-hub';
import { loadHub } from '@/lib/academy/hub-server';

/** The Learn hub desk: the featured article as staff left it, clearing it, and the topic list. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return <AcademyLearnHub initial={await loadHub(founder)} />;
}
