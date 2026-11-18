import { useState } from 'react';
import { Button, DataTable, Loading } from '../../../shared/ui';
import { usePolled } from '../../protocol/wallet/use-polled';
import type {
  AsOf,
  VenueAdlDisclosure,
  VenueDeleverage,
  VenueInsuranceFund,
  VenueLiquidation,
  VenueLiquidationAlert,
  VenueLiquidationStatus,
} from '../venue-api';
import { AsOfLine, VENUE_POLL_MS, useAsOfText, useVenueApi } from '../venue/VenueKit';
import { positionsCopy } from './positions-copy';

/**
 * A liquidation on the venue and its aftermath (J-derivatives-07): the venue liquidates, charges its fee and runs its
 * insurance fund and auto-deleveraging. Every figure here is the venue's own, read from the venue with the venue's ids and
 * its time; the app computes none of them, INTAFACED runs no fund, and our ledger posts nothing for a liquidation.
 */

interface VenueRef {
  readonly id: string;
  readonly name: string;
}

type Read<T> = { data: T; failure: null } | { data: null; failure: string };

/**
 * One position's liquidation panel (#1): the venue's state for it (none, in progress, done) and its price and fee rules,
 * polled while open. It stays open when the venue has closed the position, so the person sees the liquidation finish.
 */
export function LiquidationPanel({
  owner,
  venue: v,
  symbol,
  onClose,
}: {
  owner: string;
  venue: VenueRef;
  symbol: string;
  onClose: () => void;
}) {
  const { t } = positionsCopy.useCopy();
  const api = useVenueApi();
  const read = usePolled<Read<AsOf<VenueLiquidationStatus>>>(
    async (signal) => {
      const r = await api.liquidation(owner, { symbol, venueId: v.id }, signal);
      return { ok: true, data: r.ok ? { data: r.data, failure: null } : { data: null, failure: r.message } };
    },
    `liquidation:${owner}:${v.id}:${symbol}`,
    VENUE_POLL_MS,
  );
  const now = read.data?.data ?? null;
  const words = { symbol, venue: v.name };
  return (
    <section className="dk-panel form-stack" aria-label={t('liquidationTitle', words)} data-testid="position-liquidation">
      <h3 className="dk-tab-title">{t('liquidationTitle', words)}</h3>
      <p className="muted">{t('liquidationLead', words)}</p>
      {read.data?.failure ? (
        <p className="failure" role="alert">
          {t('liquidationNotOffered', { venue: v.name, detail: read.data.failure })}
        </p>
      ) : null}
      {now ? (
        <>
          <dl>
            <dt>{t('liquidationState')}</dt>
            <dd data-line="state" data-state={now.value.state}>
              {now.value.state === 'none'
                ? t('liquidationStateNone', words)
                : now.value.state === 'in_progress'
                  ? t('liquidationStateInProgress', { ...words, id: now.value.liquidationId ?? '' })
                  : t('liquidationStateDone', { ...words, id: now.value.liquidationId ?? '' })}
            </dd>
            <dt>{t('liquidationPriceRule')}</dt>
            <dd data-line="price-rule">{now.value.priceRule}</dd>
            <dt>{t('liquidationFeeRule')}</dt>
            <dd data-line="fee-rule">{now.value.feeRule ?? t('liquidationFeeRuleNone', words)}</dd>
          </dl>
          <AsOfLine asOf={now.asOf} />
        </>
      ) : read.data === null ? (
        <Loading label={t('liquidationTitle', words)} />
      ) : null}
      <Button variant="secondary" onClick={onClose}>
        {t('close')}
      </Button>
    </section>
  );
}

/** The liquidations, insurance fund, auto-deleveraging and public alerts of each connected venue (#2 to #7). */
export function LiquidationAftermath({ owner, venues }: { owner: string; venues: readonly VenueRef[] }) {
  return (
    <>
      <Liquidations owner={owner} venues={venues} />
      {venues.map((v) => (
        <InsuranceFund key={`fund:${v.id}`} venue={v} />
      ))}
      {venues.map((v) => (
        <Deleveraging key={`adl:${v.id}`} owner={owner} venue={v} />
      ))}
      {venues.map((v) => (
        <PublicAlerts key={`alerts:${v.id}`} venue={v} />
      ))}
    </>
  );
}

/** #2 #3: each liquidation the venue reports, every part with its price, size, fee and the venue's ids. */
function Liquidations({ owner, venues }: { owner: string; venues: readonly VenueRef[] }) {
  const { t } = positionsCopy.useCopy();
  const api = useVenueApi();
  const time = useAsOfText();
  const ids = venues.map((v) => v.id).join(',');
  const reads = usePolled<{ venue: VenueRef; read: Read<AsOf<VenueLiquidation[]>> }[]>(
    async (signal) => {
      const data = await Promise.all(
        venues.map(async (v) => {
          const r = await api.liquidations(owner, signal, v.id);
          return { venue: v, read: r.ok ? { data: r.data, failure: null } : { data: null, failure: r.message } };
        }),
      );
      return { ok: true, data };
    },
    `liquidations:${owner}:${ids}`,
    VENUE_POLL_MS,
  );
  const headers = [t('hLiquidation'), t('hMarket'), t('hSide'), t('hState'), t('hPart'), t('hSize'), t('hPrice'), t('hFee'), t('hTime')];
  return (
    <section className="dk-panel form-stack" aria-label={t('liquidationsTitle')} data-testid="liquidations">
      <h2 className="dk-tab-title">{t('liquidationsTitle')}</h2>
      {reads.data === null ? <Loading label={t('liquidationsTitle')} /> : null}
      {(reads.data ?? []).map(({ venue: v, read }) => (
        <div key={v.id} data-venue={v.id}>
          <h3 className="dk-tab-title">{t('liquidationsVenue', { venue: v.name })}</h3>
          <p className="muted">{t('liquidationsLead', { venue: v.name })}</p>
          {read.failure ? (
            <p className="failure" role="alert">
              {t('liquidationsNotOffered', { venue: v.name, detail: read.failure })}
            </p>
          ) : null}
          {read.data && read.data.value.length === 0 ? <p className="muted">{t('liquidationsNone', { venue: v.name })}</p> : null}
          {read.data && read.data.value.length > 0 ? (
            <DataTable label={t('liquidationsVenue', { venue: v.name })} headers={headers}>
              {read.data.value.flatMap((l) =>
                l.parts.map((p) => (
                  <tr key={p.partId} data-liquidation={l.liquidationId} data-part={p.partId} data-state={l.state}>
                    <td data-cell="liquidation">{l.liquidationId}</td>
                    <td data-cell="symbol">{l.symbol}</td>
                    <td data-cell="side">{t(`side_${l.side}`)}</td>
                    <td data-cell="state">{l.state === 'in_progress' ? t('stateInProgress') : t('stateDone')}</td>
                    <td data-cell="part">{p.partId}</td>
                    <td className="numeric" data-cell="size">
                      {p.size}
                    </td>
                    <td className="numeric" data-cell="price">
                      {p.price}
                    </td>
                    <td className="numeric" data-cell="fee">
                      {t('feeValue', { fee: p.fee, asset: p.feeAsset })}
                    </td>
                    <td data-cell="time">{time(p.liquidatedAt)}</td>
                  </tr>
                )),
              )}
            </DataTable>
          ) : null}
          {read.data ? <AsOfLine asOf={read.data.asOf} /> : null}
        </div>
      ))}
    </section>
  );
}

/** #4: the venue's own fund or vault and where to read it; a venue that publishes none reads "not published", never 0. */
function InsuranceFund({ venue: v }: { venue: VenueRef }) {
  const { t } = positionsCopy.useCopy();
  const api = useVenueApi();
  const read = usePolled<Read<VenueInsuranceFund>>(
    async (signal) => {
      const r = await api.insuranceFund(signal, v.id);
      return { ok: true, data: r.ok ? { data: r.data, failure: null } : { data: null, failure: r.message } };
    },
    `insurance-fund:${v.id}`,
    VENUE_POLL_MS,
  );
  const fund = read.data?.data ?? null;
  return (
    <section className="dk-panel form-stack" aria-label={t('fundTitle')} data-testid="insurance-fund" data-venue={v.id}>
      <h2 className="dk-tab-title">{t('fundTitle')}</h2>
      <p className="muted">{t('fundLead', { venue: v.name })}</p>
      {read.data === null ? <Loading label={t('fundTitle')} /> : null}
      {read.data?.failure ? (
        <p className="failure" role="alert">
          {t('fundFailed', { venue: v.name, detail: read.data.failure })}
        </p>
      ) : null}
      {fund && !fund.value.known ? <p data-line="fund-unpublished">{t('fundNotPublished')}</p> : null}
      {fund && fund.value.known ? (
        <dl>
          <dt>{t('fundName')}</dt>
          <dd data-line="fund-name">{fund.value.value.name}</dd>
          <dt>{t('fundBalance')}</dt>
          <dd className="numeric" data-line="fund-balance">
            {t('feeValue', { fee: fund.value.value.balance, asset: fund.value.value.asset })}
          </dd>
          <dt>{t('fundWhere')}</dt>
          <dd data-line="fund-where">{fund.value.value.whereToRead}</dd>
          <dt>{t('fundRule')}</dt>
          <dd data-line="fund-rule">{fund.value.value.rule}</dd>
        </dl>
      ) : null}
      {fund ? <AsOfLine asOf={fund.asOf} /> : null}
    </section>
  );
}

/**
 * #5 #6: the venue's auto-deleveraging rules and their version, "I have read this" storing the version read (a version the
 * venue has since replaced is shown as not read), and each auto-deleveraging of the person's positions with its notice.
 */
function Deleveraging({ owner, venue: v }: { owner: string; venue: VenueRef }) {
  const { t } = positionsCopy.useCopy();
  const api = useVenueApi();
  const time = useAsOfText();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disclosure = usePolled<Read<VenueAdlDisclosure>>(
    async (signal) => {
      const r = await api.adlDisclosure(signal, v.id);
      return { ok: true, data: r.ok ? { data: r.data, failure: null } : { data: null, failure: r.message } };
    },
    `adl-disclosure:${v.id}`,
    VENUE_POLL_MS,
  );
  const events = usePolled<Read<AsOf<VenueDeleverage[]>>>(
    async (signal) => {
      const r = await api.deleverages(owner, signal, v.id);
      return { ok: true, data: r.ok ? { data: r.data, failure: null } : { data: null, failure: r.message } };
    },
    `deleverages:${owner}:${v.id}`,
    VENUE_POLL_MS,
  );
  const d = disclosure.data?.data ?? null;
  async function acknowledge(version: string) {
    setProblem(null);
    setBusy(true);
    const r = await api.acknowledgeAdl(version, v.id);
    setBusy(false);
    if (!r.ok) setProblem(r.message);
    disclosure.reload();
  }
  return (
    <section className="dk-panel form-stack" aria-label={t('adlTitle')} data-testid="adl" data-venue={v.id}>
      <h2 className="dk-tab-title">{t('adlTitle')}</h2>
      <p className="muted">{t('adlLead', { venue: v.name })}</p>
      {disclosure.data === null ? <Loading label={t('adlTitle')} /> : null}
      {disclosure.data?.failure ? (
        <p className="failure" role="alert">
          {t('adlFailed', { venue: v.name, detail: disclosure.data.failure })}
        </p>
      ) : null}
      {d && !d.rules ? <p data-line="adl-none">{t('adlNone', { venue: v.name })}</p> : null}
      {d && d.rules ? (
        <>
          <p data-line="adl-version">{t('adlVersion', { version: d.rules.version })}</p>
          <p data-line="adl-rules">{d.rules.text}</p>
          <p data-line="adl-ack" data-acknowledged={String(d.acknowledged)}>
            {d.acknowledged
              ? t('adlAcknowledged', { version: d.rules.version, at: d.acknowledgedAt ? time(d.acknowledgedAt) : '' })
              : d.acknowledgedVersion
                ? t('adlStale', { old: d.acknowledgedVersion, venue: v.name, version: d.rules.version })
                : t('adlNotAcknowledged')}
          </p>
          {d.acknowledged ? null : (
            <Button disabled={busy} onClick={() => void acknowledge(d.rules!.version)}>
              {t('adlAck')}
            </Button>
          )}
          <AsOfLine asOf={d.asOf} />
        </>
      ) : null}
      {problem ? (
        <p className="failure" role="alert" data-testid="adl-problem">
          {t('adlAckFailed', { detail: problem })}
        </p>
      ) : null}
      <h3 className="dk-tab-title">{t('adlEventsTitle')}</h3>
      <p className="muted">{t('adlPaysNothing', { venue: v.name })}</p>
      {events.data?.failure ? (
        <p className="failure" role="alert">
          {t('adlFailed', { venue: v.name, detail: events.data.failure })}
        </p>
      ) : null}
      {events.data?.data && events.data.data.value.length === 0 ? <p className="muted">{t('adlEventsNone', { venue: v.name })}</p> : null}
      {(events.data?.data?.value ?? []).map((e) => (
        <div key={e.adlId} data-adl={e.adlId}>
          <p data-line="adl-close">
            {t('adlEvent', {
              venue: v.name,
              side: t(`side_${e.side}`),
              size: e.size,
              symbol: e.symbol,
              price: e.price,
              pnl: e.realisedPnl,
            })}{' '}
            <span className="muted">{time(e.deleveragedAt)}</span>
          </p>
          <p data-line="adl-notice">{e.notice}</p>
        </div>
      ))}
    </section>
  );
}

/** #7: the venue's public liquidation and auto-deleveraging alerts: market, side, size and price, with no account. */
function PublicAlerts({ venue: v }: { venue: VenueRef }) {
  const { t } = positionsCopy.useCopy();
  const api = useVenueApi();
  const time = useAsOfText();
  const read = usePolled<Read<AsOf<VenueLiquidationAlert[]>>>(
    async (signal) => {
      const r = await api.liquidationAlerts({ limit: 50, venueId: v.id }, signal);
      return { ok: true, data: r.ok ? { data: r.data, failure: null } : { data: null, failure: r.message } };
    },
    `liquidation-alerts:${v.id}`,
    VENUE_POLL_MS,
  );
  const alerts = read.data?.data ?? null;
  return (
    <section className="dk-panel form-stack" aria-label={t('alertsTitle')} data-testid="liquidation-alerts" data-venue={v.id}>
      <h2 className="dk-tab-title">{t('alertsTitle')}</h2>
      <p className="muted">{t('alertsLead', { venue: v.name })}</p>
      {read.data === null ? <Loading label={t('alertsTitle')} /> : null}
      {read.data?.failure ? (
        <p className="failure" role="alert">
          {t('alertsFailed', { venue: v.name, detail: read.data.failure })}
        </p>
      ) : null}
      {alerts && alerts.value.length === 0 ? <p className="muted">{t('alertsNone', { venue: v.name })}</p> : null}
      {alerts && alerts.value.length > 0 ? (
        <DataTable label={t('alertsTitle')} headers={[t('hKind'), t('hMarket'), t('hSide'), t('hSize'), t('hPrice'), t('hTime')]}>
          {alerts.value.map((a, i) => (
            <tr key={`${a.alertedAt}:${i}`} data-kind={a.kind} data-symbol={a.symbol}>
              <td data-cell="kind">{a.kind === 'liquidation' ? t('kindLiquidation') : t('kindDeleverage')}</td>
              <td data-cell="symbol">{a.symbol}</td>
              <td data-cell="side">{t(`side_${a.side}`)}</td>
              <td className="numeric" data-cell="size">
                {a.size}
              </td>
              <td className="numeric" data-cell="price">
                {a.price}
              </td>
              <td data-cell="time">{time(a.alertedAt)}</td>
            </tr>
          ))}
        </DataTable>
      ) : null}
      {alerts ? <AsOfLine asOf={alerts.asOf} /> : null}
    </section>
  );
}
