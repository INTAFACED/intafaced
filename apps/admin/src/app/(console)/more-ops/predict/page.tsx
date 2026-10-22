import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { DeskSectionSet } from '@/components/desk-section-set';
import '@/components/desk.css';

/**
 * Predict operations. No Predict service runs yet (INTACORE and Predict are not built), so the desk is the common eight
 * sections, each naming that blocker. It reads nothing and offers no action rather than show an empty board as healthy.
 */
export default async function Page() {
  requireModulePage('more-ops');
  await requireFounderPage();
  return (
    <div className="dk" data-testid="ops-desk-predict">
      <div className="adm-pagehead">
        <div>
          <h1>Predict operations</h1>
          <p>
            Markets, positions, resolution and payouts for Predict. No Predict service runs on this deployment yet, so every section below
            names that blocker and nothing is read.
          </p>
        </div>
      </div>
      <DeskSectionSet setId="predict" spec={null} view={null} />
    </div>
  );
}
