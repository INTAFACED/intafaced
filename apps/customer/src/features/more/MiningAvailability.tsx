import { useState } from 'react';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Tabs } from '../../shared/ui';
import { Read } from './common';
import { miningCopy } from './mining-copy';
import { miningHealth, type MiningHealth } from './mining-journey';
import { MiningRooms } from './MiningRooms';
import { miningDepthCopy } from './mining-depth-copy';
import type { Resource } from '../../shared/resource';
import './mining-availability.css';

// The Status tab is public liveness only: it supplies no customer records. The other tabs read the customer's own records
// from the pool. A configured connection or registered job is never evidence of a credit or payout.
type Status = { resource: Resource<MiningHealth>; reload: () => void };
const TABS = ['Overview', 'Workers', 'Shares', 'Rewards', 'Status'] as const;
export type MiningTab = (typeof TABS)[number];
/** `tab`: the section an address such as /mining/workers opens on; Overview for /mining. */
export function Mining({ tab: first = 'Overview' }: { tab?: MiningTab }) {
  const api = useApi();
  const status = useResource((signal) => api.plain('mining', '/health', miningHealth, { signal }), 'mining-health');
  const [tab, setTab] = useState<MiningTab>(first);
  const depth = miningDepthCopy.useCopy();
  return (
    <div className="more-grid">
      <Tabs
        items={TABS}
        value={tab}
        onChange={(value) => setTab(value as (typeof TABS)[number])}
        label={depth.t('sections')}
        labels={{
          Overview: depth.t('tabOverview'),
          Workers: depth.t('tabWorkers'),
          Shares: depth.t('tabShares'),
          Rewards: depth.t('tabRewards'),
          Status: depth.t('tabStatus'),
        }}
      />
      {tab === 'Status' ? <MiningStatusRoom status={status} /> : <MiningRooms room={tab} health={status} />}
    </div>
  );
}
function MiningStatusRoom({ status }: { status: Status }) {
  const { Copy, languageFor, directionFor } = miningCopy.useCopy();
  return (
    <div data-testid="mining-room" className="mining-room" lang={languageFor('unavailableTitle')} dir={directionFor('unavailableTitle')}>
      <section className="mining-room-primary">
        <div className="mining-room-status">
          <h2>
            <Copy k="unavailableTitle" />
          </h2>
          <p className="muted">
            <Copy k="unavailableBody" />
          </p>
        </div>
        <a className="button button--primary mining-room-support" href="/support">
          <Copy k="support" />
        </a>
        <section>
          <h3 className="mining-room-required">
            <Copy k="required" />
          </h3>
          <dl data-testid="mining-room-requirements" className="mining-room-requirements">
            {(['workers', 'shares', 'credits'] as const).map((key) => (
              <div key={key}>
                <dt>
                  <span>
                    <Copy k={key} />
                  </span>
                  <span className="mining-room-state">
                    <Copy k="unavailable" />
                  </span>
                </dt>
                <dd>
                  <Copy k={key === 'workers' ? 'workersBody' : key === 'shares' ? 'sharesBody' : 'creditsBody'} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </section>
      <aside className="mining-room-aside">
        <details className="mining-room-health">
          <summary>
            <Copy k="publicStatus" />
          </summary>
          <div className="mining-room-health-body">
            <p className="muted">
              <Copy k="readScope" />
            </p>
            <Read resource={status.resource} retry={status.reload}>
              {(s) => (
                <>
                  <dl data-testid="mining-room-health-record" className="mining-room-health-record">
                    <div>
                      <dt>
                        <Copy k="process" />
                      </dt>
                      <dd>
                        <Copy k="responding" />
                      </dd>
                    </div>
                    {(['ledger', 'pg'] as const).map((key) => (
                      <div key={key}>
                        <dt>
                          <Copy k={key === 'ledger' ? 'ledger' : 'store'} />
                        </dt>
                        <dd>
                          <Copy k={s[key].status === 'configured' ? 'configured' : 'absent'} />
                        </dd>
                      </div>
                    ))}
                    <div>
                      <dt>
                        <Copy k="jobs" />
                      </dt>
                      <dd>
                        {s.jobs.length ? (
                          s.jobs.map((job, i) => (
                            <span className="mining-room-job" lang="und" dir="ltr" key={i}>
                              {job}
                            </span>
                          ))
                        ) : (
                          <Copy k="noJobs" />
                        )}
                      </dd>
                    </div>
                  </dl>
                  <Button variant="secondary" data-testid="mining-room-refresh" className="mining-room-refresh" onClick={status.reload}>
                    <Copy k="refresh" />
                  </Button>
                </>
              )}
            </Read>
            <p className="muted">
              <Copy k="boundaries" />
            </p>
          </div>
        </details>
        <a className="text-link mining-room-link" href="/more">
          <Copy k="more" />
        </a>
      </aside>
    </div>
  );
}
