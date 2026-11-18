import { useMemo } from 'react';
import { DataTable } from '../../../shared/ui';
import { formatAmount, parseAmount } from '../../../shared/money';
import { usePolled } from '../../../features/protocol/wallet/use-polled';
import type { VenueFundingPayment, VenueMarket } from '../../../features/trade/venue-api';
import { TestMark, VENUE_POLL_MS, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { countdown } from './ContractStrip';
import { intervalText, percentOf } from './VenueFuturesDesk';
import { venueFundingCopy } from './venue-funding-copy';

/** How far back the funding payments are read. */
const FUNDING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The Funding tab of the venue futures desk (J-derivatives-08): the rate the venue publishes for the contract now, its
 * countdown and what the venue built it from, or "not published by this venue"; every funding payment the venue booked
 * on the person's positions; and a statement of them by position and period. Every figure is the venue's own, digit for
 * digit: nothing here is recomputed, and our ledger holds none of it.
 */
export function VenueFunding({ market, owner, venueName, test }: { market: VenueMarket; owner: string; venueName: string; test: boolean }) {
  const { t } = venueFundingCopy.useCopy();
  const venue = useVenueApi();
  const since = useMemo(() => new Date(Date.now() - FUNDING_WINDOW_MS).toISOString(), []);
  const read = usePolled((signal) => venue.fundingPayments(owner, since, signal), `funding:${owner}`, VENUE_POLL_MS);
  const payments = read.data?.value ?? null;
  return (
    <div className="form-stack" data-testid="venue-funding-tab">
      <FundingNow market={market} test={test} />
      <section aria-label={t('Payments title')} data-testid="venue-funding-payments">
        <h3 className="dk-tab-title">
          {t('Payments title')} <TestMark test={test} />
        </h3>
        <p className="muted">{t('Payments note', { venue: venueName })}</p>
        {payments === null ? null : payments.length === 0 ? (
          <p data-testid="venue-funding-none">{t('Payments none')}</p>
        ) : (
          <Payments payments={payments} />
        )}
      </section>
      {payments && payments.length > 0 ? <Statement payments={payments} venueName={venueName} test={test} /> : null}
    </div>
  );
}

function FundingNow({ market, test }: { market: VenueMarket; test: boolean }) {
  const { t } = venueFundingCopy.useCopy();
  const funding = market.funding.known ? market.funding.value : null;
  const inputs = funding?.inputs?.known ? funding.inputs.value : null;
  const left = funding ? countdown(funding.nextFundingAt, Date.now()) : null;
  return (
    <section aria-label={t('Funding title', { symbol: market.symbol })} data-testid="venue-funding-now">
      <h3 className="dk-tab-title">
        {t('Funding title', { symbol: market.symbol })} <TestMark test={test} />
      </h3>
      {funding ? (
        <dl className="protocol-facts">
          <div>
            <dt>{t('Rate now')}</dt>
            <dd className="numeric" data-line="rate" data-value={funding.rate}>
              {t('Rate value', { percent: percentOf(funding.rate), every: intervalText(funding.intervalSeconds) })}
            </dd>
          </div>
          <div>
            <dt>{t('Next period')}</dt>
            <dd data-line="countdown">
              <time dateTime={funding.nextFundingAt}>{left === null ? t('Next now') : t('Next in', { time: left })}</time>
            </dd>
          </div>
          {inputs ? (
            <>
              <div>
                <dt>{t('Premium')}</dt>
                <dd className="numeric" data-line="premium" data-value={inputs.premium}>
                  {percentOf(inputs.premium)}%
                </dd>
              </div>
              <div>
                <dt>{t('Interest')}</dt>
                <dd className="numeric" data-line="interest" data-value={inputs.interestRate}>
                  {percentOf(inputs.interestRate)}%
                </dd>
              </div>
              <div>
                <dt>{t('Cap')}</dt>
                <dd className="numeric" data-line="cap" data-value={inputs.rateCap}>
                  {t('Cap value', { percent: percentOf(inputs.rateCap) })}
                </dd>
              </div>
              <div>
                <dt>{t('Built from mark')}</dt>
                <dd className="numeric" data-line="mark" data-value={inputs.markPrice}>
                  {inputs.markPrice}
                </dd>
              </div>
              <div>
                <dt>{t('Built from index')}</dt>
                <dd className="numeric" data-line="index" data-value={inputs.indexPrice}>
                  {inputs.indexPrice}
                </dd>
              </div>
              <div>
                <dt>{t('Venue rule')}</dt>
                <dd data-line="rule">{inputs.rule.known ? inputs.rule.value : t('Rule unpublished')}</dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : (
        <p data-testid="venue-funding-unpublished">{t('Funding unpublished')}</p>
      )}
      {funding && !inputs ? <p data-testid="venue-funding-inputs-unpublished">{t('Inputs unpublished')}</p> : null}
    </section>
  );
}

/** The amount without its sign, as the venue wrote it: the direction says who paid. */
const unsigned = (amount: string) => (amount.startsWith('-') ? amount.slice(1) : amount);

function Payments({ payments }: { payments: readonly VenueFundingPayment[] }) {
  const { t } = venueFundingCopy.useCopy();
  return (
    <DataTable
      label={t('Payments title')}
      headers={[
        t('Payment market'),
        t('Payment period'),
        t('Payment position'),
        t('Payment mark'),
        t('Payment rate'),
        t('Payment direction'),
        t('Payment amount'),
      ]}
    >
      {[...payments].reverse().map((p) => (
        <tr key={p.paymentId} data-payment={p.paymentId} data-symbol={p.symbol} data-period={p.periodAt} data-amount={p.amount}>
          <td>{p.symbol}</td>
          <td data-cell="period">
            <time dateTime={p.periodAt}>{p.periodAt}</time>
          </td>
          <td className="numeric" data-cell="position">
            {t('Position value', { side: t(`side_${p.side}`), size: p.size })}
          </td>
          <td className="numeric" data-cell="mark">
            {p.markPrice}
          </td>
          <td className="numeric" data-cell="rate">
            {percentOf(p.rate)}%
          </td>
          <td data-cell="direction">{parseAmount(p.amount) < 0n ? t('paid') : t('received')}</td>
          <td className="numeric" data-cell="amount">
            {t('Amount value', { amount: unsigned(p.amount), asset: p.asset })}
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

/** The payments grouped by position (contract and side), each period on its own line, with each position's sum and the total by asset. */
function Statement({ payments, venueName, test }: { payments: readonly VenueFundingPayment[]; venueName: string; test: boolean }) {
  const { t } = venueFundingCopy.useCopy();
  const positions = new Map<string, VenueFundingPayment[]>();
  for (const p of payments) {
    const key = `${p.symbol}:${p.side}`;
    positions.set(key, [...(positions.get(key) ?? []), p]);
  }
  const totals = new Map<string, bigint>();
  for (const p of payments) totals.set(p.asset, (totals.get(p.asset) ?? 0n) + parseAmount(p.amount));
  return (
    <section aria-label={t('Statement title')} data-testid="venue-funding-statement">
      <h3 className="dk-tab-title">
        {t('Statement title')} <TestMark test={test} />
      </h3>
      <p className="muted">{t('Statement note', { venue: venueName })}</p>
      {[...positions.entries()].map(([key, rows]) => {
        const first = rows[0]!;
        const sum = rows.reduce((total, r) => total + parseAmount(r.amount), 0n);
        return (
          <DataTable
            key={key}
            label={t('Statement position', { symbol: first.symbol, side: t(`side_${first.side}`) })}
            headers={[t('Payment period'), t('Payment amount')]}
          >
            {rows.map((r) => (
              <tr key={r.paymentId} data-statement-period={r.periodAt} data-position={key}>
                <td>
                  <time dateTime={r.periodAt}>{r.periodAt}</time>
                </td>
                <td className="numeric" data-cell="amount">
                  {t('Amount value', { amount: r.amount, asset: r.asset })}
                </td>
              </tr>
            ))}
            <tr data-position-total={key}>
              <th scope="row">{t('Statement position total')}</th>
              <td className="numeric" data-cell="amount">
                {t('Amount value', { amount: formatAmount(sum), asset: first.asset })}
              </td>
            </tr>
          </DataTable>
        );
      })}
      <dl className="protocol-facts">
        {[...totals.entries()].map(([asset, total]) => (
          <div key={asset}>
            <dt>{t('Statement total')}</dt>
            <dd className="numeric" data-testid="venue-funding-total" data-asset={asset} data-value={formatAmount(total)}>
              {t('Amount value', { amount: formatAmount(total), asset })}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
