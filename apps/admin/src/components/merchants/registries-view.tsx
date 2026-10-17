import type { PayCallResult } from '@/lib/merchants/pay-call';
import { enabledChip, healthChip, routableChip, venueModeChip } from '@/lib/merchants/chips';
import { formatAmount } from '@/lib/merchants/money';
import { formatUtc } from '@/lib/merchants/time';
import {
  REGISTRY_INFO,
  viewKey,
  type NetworkView,
  type RegistryEventView,
  type RegistryKind,
  type RegistryView,
  type VenueView,
  type WalletRouteView,
} from '@/lib/merchants/registry-model';
import { ApprovePanel } from './approve-panel';
import { Card, FailureState, PageHead, shortId, StateBlock, StatusChip } from './ui';

export const registryHref = (kind: RegistryKind, ...rest: string[]) =>
  ['/merchants/registries', REGISTRY_INFO[kind].slug, ...rest].join('/');

export function RegistryListView({ kind, result }: { kind: RegistryKind; result: PayCallResult<RegistryView[]> }) {
  const info = REGISTRY_INFO[kind];
  const here = registryHref(kind);
  return (
    <div className="mp-page">
      <PageHead
        title={info.title}
        purpose={info.purpose}
        back={{ href: '/merchants', label: 'Merchants dashboard' }}
        actions={
          <a className="mp-btn mp-btn--primary" href={registryHref(kind, 'new')}>
            Add {info.singular}
          </a>
        }
      />
      {result.kind !== 'ok' ? (
        <FailureState failure={result} what={`The ${info.title.toLowerCase()} registry`} retryHref={here} />
      ) : result.data.length === 0 ? (
        <StateBlock
          kind="empty"
          title={`No ${info.title.toLowerCase()} yet`}
          action={
            <a className="mp-btn mp-btn--primary" href={registryHref(kind, 'new')}>
              Add the first {info.singular}
            </a>
          }
        >
          Nothing is configured, so nothing is routed here. New entries start switched off; switching one on is a separate change that needs
          a second founder.
        </StateBlock>
      ) : (
        <Card
          id="entries"
          title={`${result.data.length} ${result.data.length === 1 ? info.singular : info.title.toLowerCase()}`}
          sub="Open one to see its history and edit it."
          flush
        >
          <div className="mp-scroll" tabIndex={0} role="region" aria-label={`${info.title} table, scrolls sideways on small screens`}>
            {kind === 'venue' ? <VenueTable rows={result.data as VenueView[]} /> : null}
            {kind === 'network' ? <NetworkTable rows={result.data as NetworkView[]} /> : null}
            {kind === 'wallet_route' ? <RouteTable rows={result.data as WalletRouteView[]} /> : null}
          </div>
        </Card>
      )}
      <ApprovePanel />
    </div>
  );
}

function Updated({ at, by }: { at: string; by: string }) {
  return (
    <span className="mp-muted" title={`by ${by}`}>
      {formatUtc(at)}
    </span>
  );
}

function VenueTable({ rows }: { rows: VenueView[] }) {
  return (
    <table className="mp-table mp-table--rows">
      <caption className="mp-visually-hidden">Venues</caption>
      <thead>
        <tr>
          <th scope="col">Venue</th>
          <th scope="col">Mode</th>
          <th scope="col">On</th>
          <th scope="col">Ready</th>
          <th scope="col" className="mp-right">
            Priority
          </th>
          <th scope="col" className="mp-right">
            Order limits
          </th>
          <th scope="col">Health</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.venueId}>
            <th scope="row">
              <a className="mp-id" href={registryHref('venue', v.venueId)}>
                {v.displayName}
              </a>
              <span className="mp-sub">{v.venueId}</span>
            </th>
            <td>
              <StatusChip spec={venueModeChip(v.mode)} />
            </td>
            <td>
              <StatusChip spec={enabledChip(v.enabled)} />
            </td>
            <td>
              <StatusChip spec={routableChip(v.routable, v.missing)} />
            </td>
            <td className="mp-right mp-num">{v.priority}</td>
            <td className="mp-right mp-num">
              {v.minOrder === null && v.maxOrder === null ? (
                <span className="mp-muted">Not configured</span>
              ) : (
                `${v.minOrder === null ? '—' : formatAmount(v.minOrder)} to ${v.maxOrder === null ? '—' : formatAmount(v.maxOrder)}`
              )}
            </td>
            <td>
              <StatusChip spec={healthChip(v.health)} />
            </td>
            <td>
              <Updated at={v.updatedAt} by={v.updatedBy} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NetworkTable({ rows }: { rows: NetworkView[] }) {
  return (
    <table className="mp-table mp-table--rows">
      <caption className="mp-visually-hidden">Networks</caption>
      <thead>
        <tr>
          <th scope="col">Network</th>
          <th scope="col">On</th>
          <th scope="col">Ready</th>
          <th scope="col">Assets</th>
          <th scope="col" className="mp-right">
            Confirmations
          </th>
          <th scope="col">Fee estimate</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((n) => (
          <tr key={n.networkId}>
            <th scope="row">
              <a className="mp-id" href={registryHref('network', n.networkId)}>
                {n.displayName}
              </a>
              <span className="mp-sub">{n.networkId}</span>
            </th>
            <td>
              <StatusChip spec={enabledChip(n.enabled)} />
            </td>
            <td>
              <StatusChip spec={routableChip(n.routable, n.missing)} />
            </td>
            <td>{n.assetCodes.length ? n.assetCodes.join(', ') : <span className="mp-muted">None</span>}</td>
            <td className="mp-right mp-num">{n.confirmationsRequired ?? <span className="mp-muted">Not configured</span>}</td>
            <td>
              {n.feeEstimateSource === null ? (
                <span className="mp-muted">Not configured</span>
              ) : n.feeEstimateSource === 'fixed' && n.feeEstimateAmount ? (
                <span className="mp-num">{formatAmount(n.feeEstimateAmount)} fixed</span>
              ) : (
                n.feeEstimateSource.replace(/_/g, ' ')
              )}
            </td>
            <td>
              <Updated at={n.updatedAt} by={n.updatedBy} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RouteTable({ rows }: { rows: WalletRouteView[] }) {
  return (
    <table className="mp-table mp-table--rows">
      <caption className="mp-visually-hidden">Wallet routes</caption>
      <thead>
        <tr>
          <th scope="col">Route</th>
          <th scope="col">Payouts</th>
          <th scope="col">Ready</th>
          <th scope="col" className="mp-right">
            Largest single payout
          </th>
          <th scope="col" className="mp-right">
            Allow / deny
          </th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.routeId}>
            <th scope="row">
              <a className="mp-id" href={registryHref('wallet_route', r.routeId)}>
                {r.assetCode} on {r.networkId}
              </a>
              <span className="mp-sub" title={r.routeId}>
                {shortId(r.routeId)}
              </span>
            </th>
            <td>
              <StatusChip spec={enabledChip(r.payoutAllowed)} />
            </td>
            <td>
              <StatusChip spec={routableChip(r.routable, r.missing)} />
            </td>
            <td className="mp-right mp-num">
              {r.maxSinglePayout === null ? <span className="mp-muted">Not configured</span> : formatAmount(r.maxSinglePayout)}
            </td>
            <td className="mp-right mp-num">
              {r.merchantAllow.length} / {r.merchantDeny.length}
            </td>
            <td>
              <Updated at={r.updatedAt} by={r.updatedBy} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Newest first by the service's sequence number; rows with a non-numeric sequence keep their given order. */
export function newestFirst(events: readonly RegistryEventView[]): RegistryEventView[] {
  return [...events].sort((a, b) => {
    if (!/^\d+$/.test(a.seq) || !/^\d+$/.test(b.seq)) return 0;
    const x = BigInt(a.seq);
    const y = BigInt(b.seq);
    return x === y ? 0 : x < y ? 1 : -1;
  });
}

export function HistoryTable({
  result,
  kind,
  entryKey,
}: {
  result: PayCallResult<RegistryEventView[]>;
  kind: RegistryKind;
  entryKey: string;
}) {
  return (
    <Card
      id="history"
      title="History"
      sub="Every change, newest first: who made it, who approved it and why."
      flush={result.kind === 'ok' && result.data.length > 0}
    >
      {result.kind !== 'ok' ? (
        <FailureState failure={result} what="The history" retryHref={registryHref(kind, entryKey)} />
      ) : result.data.length === 0 ? (
        <StateBlock kind="empty" title="No history yet">
          Changes appear here the moment one is saved.
        </StateBlock>
      ) : (
        <div className="mp-scroll" tabIndex={0} role="region" aria-label="History table, scrolls sideways on small screens">
          <table className="mp-table">
            <caption className="mp-visually-hidden">Change history</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Change</th>
                <th scope="col">Made by</th>
                <th scope="col">Approved by</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {newestFirst(result.data).map((e) => (
                <tr key={e.id}>
                  <td className="mp-num">{formatUtc(e.createdAt)}</td>
                  <td>{e.action === 'create' ? 'Created' : 'Updated'}</td>
                  <td title={e.actorId}>{shortId(e.actorId)}</td>
                  <td>
                    {e.dualControl && e.approverId ? (
                      <span title={e.approverId}>{shortId(e.approverId)}</span>
                    ) : (
                      <span className="mp-muted">Not needed</span>
                    )}
                  </td>
                  <td>{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export { viewKey };
