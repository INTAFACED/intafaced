import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CapitalMonitor, ScenarioResult } from '@/components/capital/monitor';
import { CapitalThresholdForm } from '@/components/capital/threshold-form';
import { readCapital, readScenario } from '@/lib/capital/read';
import '@/components/desk.css';

/**
 * The capital monitor (RC-ops-console-06, J-ops-console-24 #1): INTAFACED's own funds from the ledger, the builder account at
 * each venue, any reserve a partner holds of ours, and each asset against its buffer threshold, as svc-ops evaluates them on
 * every open. `?scenario=counterparty_default&counterparty=…&asset=…&exposure=…&lossShare=…` runs one scenario.
 */
export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export default async function CapitalPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  const q = await searchParams;
  const asked = one(q.scenario) === 'counterparty_default';
  const [snapshot, scenario] = await Promise.all([
    readCapital(founder),
    asked
      ? readScenario(founder, {
          kind: 'counterparty_default',
          counterparty: one(q.counterparty),
          assetId: one(q.asset),
          exposure: one(q.exposure),
          lossShare: one(q.lossShare),
        })
      : Promise.resolve(null),
  ]);
  return (
    <main className="dk-stack" data-testid="capital">
      <p>
        <Link href="/more-ops">More modules</Link>
      </p>
      <h2>Capital monitor</h2>
      <p className="dk-muted">
        What INTAFACED holds of its own, beside the minimum buffer founders set for each asset. Each figure names its source; a source that
        cannot be read shows as unknown, never as zero. Nothing on this page moves money.
      </p>
      {snapshot.kind === 'ok' ? (
        <CapitalMonitor snapshot={snapshot.data} />
      ) : (
        <div
          className="adm-callout"
          data-tone={snapshot.forbidden || snapshot.notBuilt ? 'warn' : 'danger'}
          role="status"
          data-testid="read-failed"
        >
          <strong>The capital monitor could not be read</strong>
          <p>{snapshot.message}</p>
          {snapshot.code && <p className="dk-muted">Code: {snapshot.code}</p>}
          <p className="dk-muted">Nothing is shown here rather than a guess.</p>
        </div>
      )}
      <section className="dk-stack" aria-label="Run a scenario" data-testid="capital-scenario">
        <h3>Run a scenario: a counterparty defaults</h3>
        <form method="get" className="dk-row">
          <input type="hidden" name="scenario" value="counterparty_default" />
          <div className="adm-field">
            <label htmlFor="sc-counterparty">Counterparty</label>
            <input id="sc-counterparty" name="counterparty" className="adm-input" defaultValue={one(q.counterparty) ?? ''} />
          </div>
          <div className="adm-field">
            <label htmlFor="sc-asset">Asset</label>
            <input id="sc-asset" name="asset" className="adm-input" defaultValue={one(q.asset) ?? ''} />
          </div>
          <div className="adm-field">
            <label htmlFor="sc-exposure">Exposure</label>
            <input id="sc-exposure" name="exposure" className="adm-input" inputMode="decimal" defaultValue={one(q.exposure) ?? ''} />
          </div>
          <div className="adm-field">
            <label htmlFor="sc-share">Loss share (0 to 1)</label>
            <input id="sc-share" name="lossShare" className="adm-input" inputMode="decimal" defaultValue={one(q.lossShare) ?? ''} />
          </div>
          <button type="submit" className="adm-btn">
            Run the scenario
          </button>
        </form>
        {scenario && <ScenarioResult part={scenario} />}
      </section>
      <CapitalThresholdForm userId={founder.session.userId} />
    </main>
  );
}
