import { requireFounderPage } from '@/lib/founder-page';
import { JurisdictionBoard } from '@/components/jurisdiction-board';

export default async function JurisdictionPage() {
  await requireFounderPage();
  return <JurisdictionBoard />;
}
