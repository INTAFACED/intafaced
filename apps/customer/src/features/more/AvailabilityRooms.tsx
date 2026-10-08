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
      <Panel title="Mining pool connection">
        <Read resource={status.resource} retry={status.reload}>
          {(s) => (
            <Details
              items={[
                ['Pool process', s.ok ? 'Responding' : 'Unavailable'],
                ['Ledger configuration', `${s.ledger.status} · ${s.ledger.code}`],
                ['Window-store configuration', `${s.pg.status} · ${s.pg.code}`],
                ['Scheduled job registrations', s.jobs.length ? s.jobs.join(', ') : 'None registered'],
              ]}
            />
          )}
        </Read>
        <p className="muted">
          Configured dependencies are unprobed. Process liveness does not confirm a working ledger, accepted shares or a payout.
        </p>
      </Panel>
      <Panel title="Your mining activity">
        <p>
          The pool has a signed service endpoint for submitting observed shares and scheduled PPLNS payout jobs. It publishes no customer
          worker registration, owned share history, hashrate projection, reward balance or payout read.
        </p>
        <p>
          Those customer capabilities must be connected before this room can show your miners or accept an instruction. The internal
          submitShare job is not a customer form.
        </p>
        <a className="text-link" href="/support">
          Ask about pool access
        </a>
      </Panel>
    </div>
  );
}
export function Launch({ orders = false }: { orders?: boolean }) {
  return (
    <div className="more-columns">
      <Panel title={orders ? 'Your Launch participation' : 'Issue and list an asset'}>
        {orders ? (
          <>
            <p>
              No service records sale rounds or per-account participation. The retired order page read venue records with no ledger-backed
              subscription or allocation.
            </p>
            <p>
              A customer-owned participation read and ledger-backed subscription/allocation recipes are needed before an amount or order
              state can be shown.
            </p>
          </>
        ) : (
          <>
            <p>
              Asset issuance currently belongs to the parked chain plane. INTACHAIN has not been started, so this room cannot deploy a
              token, predict a live address, sign calldata or present a usable factory.
            </p>
            <p>The existing template is explicitly unaudited. Compiler artifacts do not establish an audit or permission to launch.</p>
          </>
        )}
        <div className="more-toolbar">
          <a className="text-link" href="/launch">
            Launch overview
          </a>
          <a className="text-link" href="/uc/innovation/myorders">
            My Launch orders
          </a>
        </div>
      </Panel>
      <Panel title="Listing and sale prerequisites">
        <Details
          items={[
            [
              'House-book listing',
              'The Market seller lifecycle can publish catalogue access listings. It cannot create a tradeable asset or sale round.',
            ],
            [
              'Launchpad sale',
              'Missing a round service, published sale terms, jurisdiction/tier admission, scoped participation records and ledger subscribe/allocate recipes.',
            ],
            ['Issuance', 'Parked chain work remains unstarted. No chain or deployment procedure is called by this room.'],
          ]}
        />
        <a className="text-link" href="/market/mine">
          Open your Market listings
        </a>
        <a className="text-link" href="/support">
          Contact Support
        </a>
      </Panel>
    </div>
  );
}
