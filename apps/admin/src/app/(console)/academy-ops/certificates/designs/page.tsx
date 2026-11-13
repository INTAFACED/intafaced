import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyCertDesigns } from '@/components/academy-cert-designs';
import { loadCertDesigns } from '@/lib/academy/cert-designs-server';

/** Certificate designs (AC-certificates-03): each published certificate's design, its revisions and activation. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return <AcademyCertDesigns initial={await loadCertDesigns(founder)} />;
}
