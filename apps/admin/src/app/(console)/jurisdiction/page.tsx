import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ComplianceLive } from '@/components/compliance-live';
import { JurisdictionBoard } from '@/components/jurisdiction-board';
import { loadCompliance } from '@/lib/compliance/server';

/**
 * Jurisdiction: what the running edge reports now (above), then the compiled policy matrix the build ships (below).
 * The live section is read server-side so the first paint is the edge's answer, with its own as-of time; each part
 * fails on its own and says why.
 */
export default async function JurisdictionPage() {
  requireModulePage('jurisdiction');
  await requireFounderPage();
  const initial = await loadCompliance();
  return (
    <div className="adm-stack">
      <p>
        <Link href="/compliance/cases">Compliance cases</Link>
      </p>
      <ComplianceLive initial={initial} />
      <JurisdictionBoard />
    </div>
  );
}
