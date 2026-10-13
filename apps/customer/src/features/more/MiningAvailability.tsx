import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button } from '../../shared/ui';
import { Read } from './common';
import { miningCopy } from './mining-copy';
import './mining-availability.css';

// Public liveness supplies no customer records or authority. A configured
// connection or registered job is never evidence of a credit or payout.
const miningHealth = z.object({
  ok: z.literal(true),
  service: z.literal('svc-mining-pool'),
  ledger: z.object({ status: z.enum(['absent', 'configured']), code: z.string() }),
  pg: z.object({ status: z.enum(['absent', 'configured']), code: z.string() }),
  jobs: z.array(z.string()),
});
export function Mining() {
  const api = useApi();
  const status = useResource((signal) => api.plain('mining', '/health', miningHealth, { signal }), 'mining-health');
  const { Copy, languageFor, directionFor } = miningCopy.useCopy();
  return (
    <div className="mining-room" lang={languageFor('unavailableTitle')} dir={directionFor('unavailableTitle')}>
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
          <dl className="mining-room-requirements">
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
                  <dl className="mining-room-health-record">
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
                          <small lang="und" dir="ltr">
                            {s[key].code}
                          </small>
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
                  <Button variant="secondary" className="mining-room-refresh" onClick={status.reload}>
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
