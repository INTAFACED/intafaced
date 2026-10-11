import { t as copyText, Text } from './copy';
import { z } from 'zod';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Panel } from '../../shared/ui';
import { Details, Read } from './common';
const mining = z.object({
  ok: z.literal(true),
  service: z.literal('svc-mining-pool'),
  ledger: z.object({ status: z.enum(['absent', 'configured']), code: z.string() }),
  pg: z.object({ status: z.enum(['absent', 'configured']), code: z.string() }),
  jobs: z.array(z.string()),
});
export function Mining() {
  const api = useApi();
  const status = useResource((signal) => api.plain('mining', '/health', mining, { signal }), 'mining-health');
  return (
    <div className="more-columns">
      <Panel title={copyText('availabilityrooms.mining.pool.connection')}>
        <Read resource={status.resource} retry={status.reload}>
          {(s) => (
            <Details
              items={[
                [copyText('availabilityrooms.pool.process'), copyText(s.ok ? 'common.responding' : 'common.unavailable')],
                [copyText('availabilityrooms.ledger.configuration'), `${s.ledger.status} · ${s.ledger.code}`],
                [copyText('availabilityrooms.window.store.configuration'), `${s.pg.status} · ${s.pg.code}`],
                [
                  copyText('availabilityrooms.scheduled.job.registrations'),
                  s.jobs.length ? s.jobs.join(', ') : copyText('availabilityrooms.none.registered'),
                ],
              ]}
            />
          )}
        </Read>
        <p className="muted">
          <Text k="availabilityrooms.configured.dependencies.are.unprobed.process.liveness.does" />
        </p>
      </Panel>
      <Panel title={copyText('availabilityrooms.your.mining.activity')}>
        <p>
          <Text k="availabilityrooms.the.pool.has.a.signed.service.endpoint" />
        </p>
        <p>
          <Text k="availabilityrooms.those.customer.capabilities.must.be.connected.before" />
        </p>
        <a className="text-link" href="/support">
          <Text k="availabilityrooms.ask.about.pool.access" />
        </a>
      </Panel>
    </div>
  );
}
export { Launch } from './LaunchAvailability';
