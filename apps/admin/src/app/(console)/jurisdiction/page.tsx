import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { JurisdictionBoard } from '@/components/jurisdiction-board';

export default async function JurisdictionPage() {
  requireModulePage('jurisdiction');
  await requireFounderPage();
  return <JurisdictionBoard />;
}
