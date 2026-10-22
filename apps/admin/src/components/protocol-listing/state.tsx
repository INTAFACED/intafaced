import { formatAsOf } from '@/lib/as-of';
import type { Part } from '@/lib/desk/part';
import type { ProtocolOpsMarketsListOutput, ProtocolOpsPoolsListOutput } from '@/lib/protocol-listing/read';
import '../desk.css';

function Failed({ title, part, asOf }: { title: string; part: Extract<Part<unknown>, { kind: 'failed' }>; asOf: string }) {
  return (
    <div className="adm-callout" data-tone={part.forbidden || part.notBuilt ? 'warn' : 'danger'} role="status" data-testid="read-failed">
      <strong>Could not load {title}</strong>
      <p>{part.message}</p>
      {part.code && <p className="dk-muted">Code: {part.code}</p>}
      <p className="dk-muted">Tried at {formatAsOf(asOf)}. Nothing is shown rather than a guess.</p>
    </div>
  );
}

/** Which pools and markets INTAFACED has decided about, as svc-ops answered. A target with no decision is not listed here. */
export function ListingState({
  asOf,
  pools,
  markets,
}: {
  asOf: string;
  pools: Part<ProtocolOpsPoolsListOutput>;
  markets: Part<ProtocolOpsMarketsListOutput>;
}) {
  return (
    <div className="dk-stack" data-testid="listing-state">
      <h3>Pools</h3>
      {pools.kind === 'failed' ? (
        <Failed title="the pool list" part={pools} asOf={asOf} />
      ) : pools.data.pools.length === 0 ? (
        <p className="dk-muted" data-testid="pools-empty">
          No pool has a listing decision. Every pool is listed unless it is hidden here.
        </p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label="Pools" tabIndex={0}>
          <table className="adm-table" data-testid="pools-table">
            <thead>
              <tr>
                <th scope="col">Chain</th>
                <th scope="col">Pool</th>
                <th scope="col">State</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {pools.data.pools.map((p) => (
                <tr key={`${p.chainId}:${p.poolAddress}`}>
                  <td>{p.chainId}</td>
                  <td>{p.poolAddress}</td>
                  <td>{p.state === 'hidden' ? 'Hidden by INTAFACED' : p.state === 'applying' ? 'Being applied' : 'Listed'}</td>
                  <td>{p.hidden ? `${p.hidden.reasonCode}: ${p.hidden.reason}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Markets</h3>
      {markets.kind === 'failed' ? (
        <Failed title="the market list" part={markets} asOf={asOf} />
      ) : markets.data.markets.length === 0 ? (
        <p className="dk-muted" data-testid="markets-empty">
          No market has a listing decision. Every market is quoted unless it is delisted here.
        </p>
      ) : (
        <div className="dk-table-wrap" role="region" aria-label="Markets" tabIndex={0}>
          <table className="adm-table" data-testid="markets-table">
            <thead>
              <tr>
                <th scope="col">Market</th>
                <th scope="col">State</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {markets.data.markets.map((m) => (
                <tr key={m.symbol}>
                  <td>{m.symbol}</td>
                  <td>{m.state === 'hidden' ? 'Delisted by INTAFACED' : m.state === 'applying' ? 'Being applied' : 'Listed'}</td>
                  <td>{m.hidden ? `${m.hidden.reasonCode}: ${m.hidden.reason}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="dk-muted">As of {formatAsOf(asOf)}.</p>
    </div>
  );
}
