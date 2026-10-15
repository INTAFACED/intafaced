import type { TreasuryData } from '@/lib/merchants/loaders';
import { formatAmount } from '@/lib/merchants/money';
import { describeFreshness } from '@/lib/merchants/time';
import { AutoTripCard, HaltHistoryTable, HaltStatesTable, PendingClearsGap } from './halts-panels';
import { AsOf, Card, FailureState, KpiTile, PageHead, StateBlock } from './ui';

export function TreasuryView({ data, currentUserId }: { data: TreasuryData; currentUserId?: string }) {
  const here = '/merchants/treasury';
  const exposure = data.exposure.kind === 'ok' ? data.exposure.data : null;
  const status = data.status.kind === 'ok' ? data.status.data : null;
  const halted = status?.states.filter((s) => s.halted).length ?? null;
  const readFresh = { asOf: data.readAt, lagSeconds: 0 };
  return (
    <div className="mp-page">
      <PageHead
        title="Treasury and halts"
        purpose="How much the platform is exposed per asset, which operations are paused, and whether anything pauses by itself. Read only: changing a limit or a halt needs two founders and is not done from this page yet."
        back={{ href: '/merchants', label: 'Merchants dashboard' }}
      />

      <div className="mp-kpis" role="group" aria-label="Treasury and halt summary">
        <KpiTile
          label="Assets with an exposure limit"
          value={
            exposure ? (
              <span className="mp-num">
                {exposure.perAsset.filter((a) => a.limit !== null).length} of {exposure.perAsset.length}
              </span>
            ) : (
              <span className="mp-muted">Unavailable</span>
            )
          }
          period={exposure ? `As of ${describeFreshness(exposure.freshness).asOf}` : 'Could not be read'}
          href="#exposure"
        />
        <KpiTile
          label="Assets with no limit"
          value={
            exposure ? (
              <span className="mp-num">{exposure.perAsset.filter((a) => a.limit === null).length}</span>
            ) : (
              <span className="mp-muted">Unavailable</span>
            )
          }
          period={exposure ? 'Conversions refuse for these' : 'Could not be read'}
          href="#exposure"
        />
        <KpiTile
          label="Operations halted"
          value={halted === null ? <span className="mp-muted">Unavailable</span> : <span className="mp-num">{halted}</span>}
          period={status ? `As of ${describeFreshness(readFresh).asOf}` : 'Could not be read'}
          note={status && !status.readable ? 'The halt store is unreadable: treat everything as halted' : undefined}
          href="#current"
        />
        <KpiTile
          label="Automatic trip"
          value={
            status ? (
              <span>{status.autoTrip.enabled ? `After ${status.autoTrip.consecutiveFailures} failures` : 'Off'}</span>
            ) : (
              <span className="mp-muted">Unavailable</span>
            )
          }
          period={status ? `As of ${describeFreshness(readFresh).asOf}` : 'Could not be read'}
          href="#auto-trip"
        />
      </div>

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
              <div className="mp-scroll" tabIndex={0} role="region" aria-label="Exposure table, scrolls sideways on small screens">
                <table className="mp-table mp-table--rows">
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
              </div>
            )}
            <p className="mp-footnote mp-mt">
              A missing limit is never read as unlimited. Nobody has agreed default limits, so none are shown.{' '}
              {describeFreshness(data.exposure.data.freshness).sentence}
            </p>
          </>
        )}
      </Card>

      <Card
        id="auto-trip"
        title="Automatic trip"
        sub="Whether a run of venue or rail failures pauses an operation without a founder. There is no default failure count."
      >
        {data.status.kind !== 'ok' ? (
          <FailureState failure={data.status} what="The automatic trip setting" retryHref={here} />
        ) : (
          <>
            <AsOf freshness={readFresh} label="Setting" />
            <AutoTripCard autoTrip={data.status.data.autoTrip} />
          </>
        )}
      </Card>

      <Card
        id="current"
        title="Halt switches now"
        sub="Every operation, for everyone, and any merchant-specific halt. A halt on one operation leaves the others running."
      >
        {data.status.kind !== 'ok' ? (
          <FailureState failure={data.status} what="The halt switches" retryHref={here} />
        ) : !data.status.data.readable ? (
          <StateBlock kind="error" title="The halt store could not be read">
            An unreadable store counts as halted. Treat every operation as paused until it can be read.
          </StateBlock>
        ) : (
          <>
            <AsOf freshness={readFresh} label="Switches" />
            <HaltStatesTable states={data.status.data.states} caption="Halt switches now" />
          </>
        )}
      </Card>

      <Card
        id="pending-clears"
        title="Halt clears waiting for a second founder"
        sub="A halt only comes off when two different founders agree."
      >
        <PendingClearsGap />
      </Card>

      <Card
        id="halts"
        title="Halt history"
        sub="Operations that were paused or resumed, by whom or automatically, who confirmed a clear, and why. Newest first."
      >
        {data.halts.kind !== 'ok' ? (
          <FailureState failure={data.halts} what="Halt history" retryHref={here} />
        ) : data.halts.data.length === 0 ? (
          <StateBlock kind="empty" title="No halts recorded">
            Nothing has been paused. When a founder or an automatic trip pauses intake, conversion, payout or settlement, it is listed here.
          </StateBlock>
        ) : (
          <>
            <AsOf freshness={readFresh} label="History" />
            <HaltHistoryTable events={data.halts.data} currentUserId={currentUserId} />
          </>
        )}
      </Card>
    </div>
  );
}
