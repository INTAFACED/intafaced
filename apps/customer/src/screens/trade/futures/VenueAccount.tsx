import { useMemo, useState } from 'react';
import { DataTable, Tabs } from '../../../shared/ui';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import type { VenueFeeRates, VenueMarket, VenueOtherFee, VenuePublicFees, VenueUp } from '../../../features/trade/venue-api';
import { ReadProblem, TestMark, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { bpsToPercent, rateShown } from '../../../features/trade/venue/fee-rates';
import { VenueTierView } from '../../../features/public/VenueFees';
import { venueAccountCopy } from './venue-account-copy';
import { billsOf, type VenueBill } from './venue-account-logic';
import { percentOf } from './venue-risk-logic';

type T = ReturnType<typeof venueAccountCopy.useCopy>['t'];
type Tab = 'fees' | 'vip' | 'account' | 'bills' | 'eligible';
const TABS: readonly Tab[] = ['fees', 'vip', 'account', 'bills', 'eligible'];
/** Account reads change only when the person trades or the venue books something: read every 5 s while open. */
const ACCOUNT_POLL_MS = 5_000;
/** How far back the bills log reads. */
const BILLS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

interface VenueRef {
  readonly id: string;
  readonly name: string;
  readonly test: boolean;
}

/** Every venue the door connects, the primary first; an older door names only the primary. */
function venuesOf(status: VenueUp): VenueRef[] {
  const listed = (status.venues ?? [])
    .filter((v): v is typeof v & { venueId: string } => v.venueId !== null)
    .map((v) => ({ id: v.venueId, name: v.displayName ?? v.venueId, test: v.test }));
  return listed.length > 0 ? listed : [{ id: status.venue.id, name: status.venue.displayName, test: status.test }];
}

/**
 * J-derivatives-12: the trader's "is my account what I think it is" view on the venue futures desk, for each connected
 * venue: our fees beside the venue's, its VIP levels and other fees, the account's balances, summary and configuration, the
 * bills log, and the instruments it may open. Every figure is the venue's own as it reports it, line by line; our builder
 * fee is ours and each fill's carries the ledger entry we booked it under. Nothing is recomputed or filled in.
 */
export function VenueAccount({ status, owner }: { status: VenueUp; owner: string }) {
  const { t } = venueAccountCopy.useCopy();
  const [tab, setTab] = useState<Tab>('fees');
  const venues = venuesOf(status);
  return (
    <section className="dk-panel" aria-label={t('Account title')} data-testid="venue-account">
      <h2 className="dk-tab-title">
        {t('Account title')} <TestMark test={status.test} />
      </h2>
      <p className="muted">{t('Account note')}</p>
      <Tabs
        items={TABS}
        value={tab}
        onChange={(x) => setTab(x as Tab)}
        label={t('Account title')}
        labels={{
          fees: t('Tab fees'),
          vip: t('Tab vip'),
          account: t('Tab account'),
          bills: t('Tab bills'),
          eligible: t('Tab eligible'),
        }}
      />
      {venues.map((v) => (
        <section key={`${tab}:${v.id}`} aria-label={t('Venue heading', { venue: v.name })} data-venue={v.id} data-tab={tab}>
          <h3 className="dk-tab-title">
            {t('Venue heading', { venue: v.name })} <TestMark test={v.test} />
          </h3>
          {tab === 'fees' ? <FeesPanel venue={v} owner={owner} /> : null}
          {tab === 'vip' ? <VipPanel venue={v} owner={owner} /> : null}
          {tab === 'account' ? <AccountPanel venue={v} owner={owner} /> : null}
          {tab === 'bills' ? <BillsPanel venue={v} owner={owner} /> : null}
          {tab === 'eligible' ? <EligiblePanel venue={v} /> : null}
        </section>
      ))}
    </section>
  );
}

function Rate({ bps, t }: { bps: VenueFeeRates['makerFeeBps']; t: T }) {
  if (!bps.known) return <>{t('Not published')}</>;
  const shown = rateShown(bps.value);
  if (shown.kind === 'zero') return <>{t('Zero fee')}</>;
  return <>{shown.kind === 'rebate' ? t('Rebate', { pct: shown.value }) : t('Pct', { pct: shown.value })}</>;
}

// ── #1 My fees ──

function FeesPanel({ venue, owner }: { venue: VenueRef; owner: string }) {
  const { t } = venueAccountCopy.useCopy();
  const api = useVenueApi();
  const fees = usePolled((signal) => api.publicFees(signal, venue.id), `acct-fees:${venue.id}`, ACCOUNT_POLL_MS);
  const tier = usePolled((signal) => api.feeTier(owner, signal, venue.id), `acct-tier:${venue.id}:${owner}`, ACCOUNT_POLL_MS);
  const markets = fees.data?.value.markets ?? null;
  const own = tier.data?.value.account ?? null;
  return (
    <div className="form-stack" data-testid="venue-my-fees">
      <ReadProblem failure={fees.failure ?? tier.failure} venueName={venue.name} />
      {markets !== null && markets.length === 0 ? <p>{t('No markets')}</p> : null}
      {markets !== null
        ? (['perpetual', 'spot'] as const).map((family) => {
            const rows = markets.filter((m) => m.kind === family);
            if (rows.length === 0) return null;
            const label = family === 'perpetual' ? t('Family perpetual') : t('Family spot');
            const rates = own ? own[family] : null;
            return (
              <div key={family} data-family={family}>
                <p data-line="family-rates">
                  {rates && (rates.makerFeeBps.known || rates.takerFeeBps.known) ? (
                    <>
                      {t('Your rates', { family: label })} {t('Maker label')}{' '}
                      <span data-cell="maker" data-value={rates.makerFeeBps.known ? rates.makerFeeBps.value : ''}>
                        <Rate bps={rates.makerFeeBps} t={t} />
                      </span>
                      , {t('Taker label')}{' '}
                      <span data-cell="taker" data-value={rates.takerFeeBps.known ? rates.takerFeeBps.value : ''}>
                        <Rate bps={rates.takerFeeBps} t={t} />
                      </span>
                    </>
                  ) : (
                    t('Your rates per market', { family: label })
                  )}
                </p>
                <DataTable label={label} headers={[t('Col market'), t('Col maker'), t('Col taker'), t('Col builder')]}>
                  {rows.map((m) => (
                    <FeeRow key={m.symbol} m={m} t={t} />
                  ))}
                </DataTable>
              </div>
            );
          })
        : null}
    </div>
  );
}

function FeeRow({ m, t }: { m: VenuePublicFees['value']['markets'][number]; t: T }) {
  return (
    <tr data-market={m.symbol} data-family={m.kind}>
      <th scope="row">{m.symbol}</th>
      <td className="numeric" data-cell="maker" data-value={m.makerFeeBps.known ? m.makerFeeBps.value : ''}>
        <Rate bps={m.makerFeeBps} t={t} />
      </td>
      <td className="numeric" data-cell="taker" data-value={m.takerFeeBps.known ? m.takerFeeBps.value : ''}>
        <Rate bps={m.takerFeeBps} t={t} />
      </td>
      <td className="numeric" data-cell="builder" data-value={m.builderFeeBps.known ? m.builderFeeBps.value : ''}>
        {m.builderFeeBps.known
          ? m.kind === 'spot'
            ? t('On sells', { pct: bpsToPercent(m.builderFeeBps.value) })
            : t('Pct', { pct: bpsToPercent(m.builderFeeBps.value) })
          : t('Fee schedule not set')}
      </td>
    </tr>
  );
}

// ── #2 VIP levels and the venue's other fees ──

function VipPanel({ venue, owner }: { venue: VenueRef; owner: string }) {
  const { t } = venueAccountCopy.useCopy();
  const api = useVenueApi();
  const tier = usePolled((signal) => api.feeTier(owner, signal, venue.id), `acct-tier:${venue.id}:${owner}`, ACCOUNT_POLL_MS);
  const other = tier.data?.value.otherFees ?? null;
  return (
    <div className="form-stack" data-testid="venue-vip">
      <ReadProblem failure={tier.failure} venueName={venue.name} />
      {tier.data ? <VenueTierView tier={tier.data} /> : null}
      {tier.data ? (
        <section aria-label={t('Other fees title')} data-testid="venue-other-fees">
          <h4 className="dk-tab-title">{t('Other fees title')}</h4>
          {other === null ? (
            <p data-testid="venue-other-fees-unpublished">{t('Other fees unpublished')}</p>
          ) : (
            <DataTable label={t('Other fees title')} headers={[t('Col fee'), t('Col applies'), t('Col rate'), t('Col rule')]}>
              {other.map((f) => (
                <OtherFeeRow key={`${f.kind}:${f.symbol ?? '*'}`} f={f} t={t} />
              ))}
            </DataTable>
          )}
        </section>
      ) : null}
    </div>
  );
}

function OtherFeeRow({ f, t }: { f: VenueOtherFee; t: T }) {
  return (
    <tr data-other-fee={`${f.kind}:${f.symbol ?? '*'}`} data-kind={f.kind}>
      <th scope="row" data-cell="name">
        {t(`kind_${f.kind}`)}: {f.name}
      </th>
      <td data-cell="applies">{f.symbol ?? t('Every market')}</td>
      <td className="numeric" data-cell="rate" data-value={f.feeBps}>
        {t('Pct', { pct: bpsToPercent(f.feeBps) })}
      </td>
      <td data-cell="rule">{f.rule}</td>
    </tr>
  );
}

// ── #3 Balances, summary and configuration ──

function AccountPanel({ venue, owner }: { venue: VenueRef; owner: string }) {
  const { t } = venueAccountCopy.useCopy();
  const api = useVenueApi();
  const balances = usePolled(
    (signal) => api.balances(owner, signal, undefined, venue.id),
    `acct-bal:${venue.id}:${owner}`,
    ACCOUNT_POLL_MS,
  );
  const summary = usePolled((signal) => api.accountSummary(owner, signal, venue.id), `acct-sum:${venue.id}:${owner}`, ACCOUNT_POLL_MS);
  const markets = usePolled((signal) => api.markets(signal, venue.id), `acct-mkts:${venue.id}`, ACCOUNT_POLL_MS * 6);
  const rows = balances.data?.value ?? null;
  const s = summary.data?.value ?? null;
  const perps = (markets.data?.value ?? []).filter((m) => m.kind === 'perpetual');
  return (
    <div className="form-stack" data-testid="venue-account-summary">
      <ReadProblem failure={balances.failure ?? markets.failure} venueName={venue.name} />
      <h4 className="dk-tab-title">{t('Balances title')}</h4>
      {rows !== null && rows.length === 0 ? <p>{t('No balances')}</p> : null}
      {rows !== null && rows.length > 0 ? (
        <DataTable label={t('Balances title')} headers={[t('Col asset'), t('Col free'), t('Col locked'), t('Col total')]}>
          {rows.map((b) => (
            <tr key={b.asset} data-asset={b.asset}>
              <th scope="row">{b.asset}</th>
              <td className="numeric" data-cell="free">
                {b.free}
              </td>
              <td className="numeric" data-cell="locked">
                {b.locked}
              </td>
              <td className="numeric" data-cell="total">
                {b.total}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : null}
      <h4 className="dk-tab-title">{t('Summary title')}</h4>
      {summary.failure ? <p data-testid="venue-summary-unread">{t('Not reported')}</p> : null}
      {s ? (
        <dl className="protocol-facts" data-testid="venue-summary" data-asset={s.asset}>
          <SummaryLine name="equity" label={t('Equity')} value={`${s.equity} ${s.asset}`} />
          <SummaryLine name="free" label={t('Summary free')} value={`${s.free} ${s.asset}`} />
          <SummaryLine name="used" label={t('Used margin')} value={`${s.usedMargin} ${s.asset}`} />
          <SummaryLine name="maintenance" label={t('Maintenance margin')} value={`${s.maintenanceMargin} ${s.asset}`} />
          <SummaryLine name="ratio" label={t('Margin ratio')} value={s.marginRatio.known ? s.marginRatio.value : t('Not reported')} />
        </dl>
      ) : null}
      <h4 className="dk-tab-title">{t('Config title')}</h4>
      {perps.length > 0 ? (
        <DataTable label={t('Config title')} headers={[t('Col market'), t('Col margin mode'), t('Col leverage'), t('Col collateral')]}>
          {perps.map((m) => (
            <ConfigRow key={m.symbol} market={m} venue={venue} owner={owner} />
          ))}
        </DataTable>
      ) : null}
    </div>
  );
}

function SummaryLine({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="numeric" data-line={name}>
        {value}
      </dd>
    </div>
  );
}

/** One perpetual's margin mode and leverage as the venue holds them for the account, and the collateral it takes there. */
function ConfigRow({ market, venue, owner }: { market: VenueMarket; venue: VenueRef; owner: string }) {
  const { t } = venueAccountCopy.useCopy();
  const api = useVenueApi();
  const lev = usePolled(
    (signal) => api.leverage(owner, market.symbol, signal, venue.id),
    `acct-lev:${venue.id}:${owner}:${market.symbol}`,
    ACCOUNT_POLL_MS * 2,
  );
  const set = lev.data?.value ?? null;
  const collateral = market.collateral?.known ? market.collateral.value : null;
  return (
    <tr data-market={market.symbol} data-margin-mode={set?.marginMode ?? ''}>
      <th scope="row">{market.symbol}</th>
      <td data-cell="margin-mode">{lev.data ? (set ? t(`mode_${set.marginMode}`) : t('Not set on venue')) : null}</td>
      <td className="numeric" data-cell="leverage" data-value={set ? String(set.leverageBps) : ''}>
        {set ? t('Leverage value', { times: String(set.leverageBps / 10_000) }) : null}
      </td>
      <td data-cell="collateral">
        {collateral
          ? collateral
              .map((c) =>
                c.haircut.known
                  ? t('Collateral value', { asset: c.asset, haircut: percentOf(c.haircut.value) })
                  : t('Collateral haircut unpublished', { asset: c.asset }),
              )
              .join('; ')
          : t('Not published')}
      </td>
    </tr>
  );
}

// ── #4 Bills ──

function BillsPanel({ venue, owner }: { venue: VenueRef; owner: string }) {
  const { t } = venueAccountCopy.useCopy();
  const api = useVenueApi();
  const since = useMemo(() => new Date(Date.now() - BILLS_WINDOW_MS).toISOString(), []);
  const key = `${venue.id}:${owner}`;
  const funding = usePolled((signal) => api.fundingPayments(owner, since, signal, venue.id), `bills-fund:${key}`, ACCOUNT_POLL_MS);
  const fills = usePolled((signal) => api.fills(owner, since, signal, { venueId: venue.id }), `bills-fills:${key}`, ACCOUNT_POLL_MS);
  const liquidations = usePolled((signal) => api.liquidations(owner, signal, venue.id), `bills-liq:${key}`, ACCOUNT_POLL_MS);
  const ours = usePolled((signal) => api.builderFees(owner, since, signal, venue.id), `bills-ours:${key}`, ACCOUNT_POLL_MS);
  const ready = funding.data && fills.data && liquidations.data && ours.data;
  const bills = ready
    ? billsOf({
        funding: funding.data!.value,
        fills: fills.data!.value,
        liquidations: liquidations.data!.value,
        builderFees: ours.data!.value,
      })
    : null;
  const failure = funding.failure ?? fills.failure ?? liquidations.failure ?? ours.failure;
  return (
    <div className="form-stack" data-testid="venue-bills">
      <ReadProblem failure={failure} venueName={venue.name} />
      <p className="muted">{t('Bills note')}</p>
      {bills !== null && bills.length === 0 ? <p data-testid="venue-bills-none">{t('Bills none')}</p> : null}
      {bills !== null && bills.length > 0 ? (
        <DataTable
          label={t('Tab bills')}
          headers={[t('Col time'), t('Col type'), t('Col market'), t('Col amount'), t('Col venue id'), t('Col ledger')]}
        >
          {bills.map((b) => (
            <BillRow key={`${b.kind}:${b.venueRef}`} b={b} t={t} />
          ))}
        </DataTable>
      ) : null}
    </div>
  );
}

function BillRow({ b, t }: { b: VenueBill; t: T }) {
  return (
    <tr
      data-bill={b.kind}
      data-venue-ref={b.venueRef}
      data-amount={b.amount}
      data-ledger-tx={b.kind === 'builder_fee' ? (b.ledgerTxId ?? '') : undefined}
      data-liquidation={b.kind === 'liquidation' ? b.liquidationId : undefined}
    >
      <td data-cell="time">
        <time dateTime={b.at}>{b.at}</time>
      </td>
      <td data-cell="type">{t(`bill_${b.kind}`)}</td>
      <td data-cell="market">{b.symbol}</td>
      <td className="numeric" data-cell="amount">
        {t('Amount value', { amount: b.amount, asset: b.asset })}
      </td>
      <td data-cell="venue-id">{b.venueRef}</td>
      <td data-cell="ledger">
        {b.kind !== 'builder_fee'
          ? t('Not ours ledger')
          : b.ledgerTxId
            ? b.ledgerTxId
            : b.ledgerStatus === 'refused'
              ? t('Ledger refused')
              : b.ledgerStatus === 'not_our_order'
                ? t('Ledger not ours')
                : t('Ledger pending')}
      </td>
    </tr>
  );
}

// ── #5 Eligible instruments and the settle currency ──

function EligiblePanel({ venue }: { venue: VenueRef }) {
  const { t } = venueAccountCopy.useCopy();
  const api = useVenueApi();
  const read = usePolled((signal) => api.eligibleInstruments(signal, venue.id), `acct-eligible:${venue.id}`, ACCOUNT_POLL_MS);
  const e = read.data?.value ?? null;
  const settle = e ? [...new Set(e.instruments.map((i) => i.settleAsset))] : [];
  return (
    <div className="form-stack" data-testid="venue-eligible">
      <ReadProblem failure={read.failure} venueName={venue.name} />
      <p className="muted">{t('Eligible note')}</p>
      {e && e.instruments.length === 0 ? (
        <p data-testid="venue-eligible-none" data-code={e.reason?.code ?? ''}>
          {t('Eligible none')} {e.reason?.message ?? ''}
        </p>
      ) : null}
      {e && e.instruments.length > 0 ? (
        <>
          <p data-testid="venue-settle-currency">{t('Settle line', { assets: settle.join(', ') })}</p>
          <DataTable label={t('Tab eligible')} headers={[t('Col market'), t('Col settle'), t('Col max leverage')]}>
            {e.instruments.map((i) => (
              <tr key={i.symbol} data-instrument={i.symbol}>
                <th scope="row">{i.symbol}</th>
                <td data-cell="settle">{i.settleAsset}</td>
                <td className="numeric" data-cell="max-leverage">
                  {i.maxLeverageBps === null ? t('No limit') : t('Leverage value', { times: String(i.maxLeverageBps / 10_000) })}
                </td>
              </tr>
            ))}
          </DataTable>
        </>
      ) : null}
    </div>
  );
}
