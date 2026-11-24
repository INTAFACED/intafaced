import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { QuantLibraryDesk } from '@/components/quant-library-desk';
import { loadLibraryDesk } from '@/lib/quant-library-ops/server';

/** The market desk's strategy library (J-algo-dev-10): the review queue, hide, unhide, remove and disputes, from svc-quant. */
export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return <QuantLibraryDesk initial={await loadLibraryDesk(founder)} />;
}
