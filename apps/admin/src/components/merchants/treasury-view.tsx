import type { TreasuryData } from '@/lib/merchants/loaders';
import { haltChip } from '@/lib/merchants/chips';
import { formatAmount } from '@/lib/merchants/money';
import { describeFreshness, formatUtc } from '@/lib/merchants/time';
import { AsOf, Card, FailureState, PageHead, shortId, StateBlock, StatusChip } from './ui';

export function TreasuryView({ data }: { data: TreasuryData }) {
  const here = '/merchants/treasury';
  return (
    <div className="mp-page">
      <PageHead
        title="Treasury and halts"
        purpose="How much the platform is exposed per asset, and which operations are paused. Read only: changing a limit or a halt needs a second founder and arrives with W5."
        back={{ href: '/merchants', label: 'Merchants dashboard' }}
      />

      <Card
        id="exposure"
        title="Exposure"
        sub="Open conversion inventory and pending payouts per asset, against the limit an owner has set."
      >
        {data.exposure.kind !== 'ok' ? (
          <FailureState failure={data.exposure} what="Treasury exposure" retryHref={here} />
        ) : (
          <>
            <AsOf freshness={data.exposure.data.freshness} label="Exposure" />
            {data.exposure.data.perAsset.length === 0 ? (
              <StateBlock kind="empty" title="No exposure to report">
                No asset has open conversion inventory or pending payouts.
              </StateBlock>
            ) : (
              <table className="mp-table">
                <caption className="mp-visually-hidden">Exposure per asset</caption>
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col" className="mp-right">
                      Open conversion inventory
                    </th>
                    <th scope="col" className="mp-right">
                      Pending payouts
                    </th>
                    <th scope="col" className="mp-right">
                      Limit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.exposure.data.perAsset.map((a) => (
                    <tr key={a.assetCode}>
                      <th scope="row">{a.assetCode}</th>
                      <td className="mp-right mp-num">
                        {a.openConversionInventory === null ? (
                          <span className="mp-muted">Not measured yet</span>
                        ) : (
                          formatAmount(a.openConversionInventory)
                        )}
                      </td>
                      <td className="mp-right mp-num">{formatAmount(a.pendingPayouts)}</td>
                      <td className="mp-right mp-num">
                        {a.limit === null ? <span className="mp-warn">Not set: conversions refuse</span> : formatAmount(a.limit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mp-footnote mp-mt">
              A missing limit is never read as unlimited. Nobody has agreed default limits, so none are shown.{' '}
              {describeFreshness(data.exposure.data.freshness).sentence}
            </p>
          </>
        )}
      </Card>

      <Card
        id="halts"
        title="Halt history"
        sub="Operations that were paused, by whom or automatically, and why. Newest entries first as the service returns them."
      >
        {data.halts.kind !== 'ok' ? (
          <FailureState failure={data.halts} what="Halt history" retryHref={here} />
        ) : data.halts.data.length === 0 ? (
          <StateBlock kind="empty" title="No halts recorded">
            Nothing has been paused. When an operator or an automatic trip pauses intake, conversion, payout or settlement, it is listed
            here.
          </StateBlock>
        ) : (
          <div className="mp-scroll" tabIndex={0} role="region" aria-label="Halt history table, scrolls sideways on small screens">
            <table className="mp-table">
              <caption className="mp-visually-hidden">Halt history</caption>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Covers</th>
                  <th scope="col">State</th>
                  <th scope="col">Set by</th>
                  <th scope="col">Why</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {data.halts.data.map((h, i) => (
                  <tr key={`${h.scope}-${h.version}-${i}`}>
                    <th scope="row">{h.scope}</th>
                    <td>{h.target.level === 'global' ? 'Everyone' : `Merchant ${shortId(h.target.merchantId)}`}</td>
                    <td>
                      <StatusChip spec={haltChip(h.halted)} />
                    </td>
                    <td>
                      {h.source === 'auto_trip' ? (
                        'Automatic trip'
                      ) : h.source === 'operator' ? (
                        h.confirmedByUserId ? (
                          'A founder, confirmed by a second founder'
                        ) : (
                          'A founder'
                        )
                      ) : (
                        <span className="mp-muted">Unknown</span>
                      )}
                    </td>
                    <td>{h.reason ?? <span className="mp-muted">—</span>}</td>
                    <td className="mp-num">{formatUtc(h.changedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
