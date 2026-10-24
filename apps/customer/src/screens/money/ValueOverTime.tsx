import { useMemo } from 'react';
import { moneyCopy } from './copy';
import { Amount, Skeleton, StateBlock, fmtUsd, refusalCopy } from './deps';
import { useValueOverTime } from './pnl-source';
import { INTERVAL_COPY, LINE_H, TimeLine } from './time-line';
import { stamp } from './time';
import {
  BRIDGE_LEGS,
  bridgeValue,
  signedLine,
  valueLine,
  valueMissingOf,
  type BankValueOverTime,
  type BridgeLeg,
} from './value-time-model';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/** The bank's own refusals for this read, in plain words; any other code takes the shared refusal words. */
const VALUE_REFUSAL: Record<
  string,
  'Pnl range refused' | 'Pnl range too long' | 'Pnl prices unavailable' | 'Value history too large' | 'Value history unavailable'
> = {
  'bank.value_range_invalid': 'Pnl range refused',
  'bank.value_range_too_long': 'Pnl range too long',
  'bank.prices_unavailable': 'Pnl prices unavailable',
  'bank.value_history_too_large': 'Value history too large',
  'bank.value_history_unavailable': 'Value history unavailable',
};

const LEG_COPY: Record<
  BridgeLeg,
  'Bridge opening' | 'Bridge deposits' | 'Bridge withdrawals' | 'Bridge fees' | 'Bridge other' | 'Bridge market' | 'Bridge closing'
> = {
  opening: 'Bridge opening',
  deposits: 'Bridge deposits',
  withdrawals: 'Bridge withdrawals',
  fees: 'Bridge fees',
  otherFlows: 'Bridge other',
  marketMove: 'Bridge market',
  closing: 'Bridge closing',
};

function ValueRows({ data, hidden, copy }: { data: BankValueOverTime; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  return (
    <details className="money-pnl-points">
      <summary>{t('Value points table')}</summary>
      <table className="money-table" aria-label={t('Value points table')}>
        <thead>
          <tr>
            <th scope="col">{t('Pnl point time')}</th>
            <th scope="col" className="money-num">
              {t('Value point total')}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.points.map((point) => (
            <tr key={point.at} data-value-point={point.at} data-usd={point.valueUsd ?? 'missing'}>
              <th scope="row">{stamp(point.at, timeZone)}</th>
              <td className="money-num">
                {point.valueUsd === null ? t('Pnl point missing') : <Amount value={fmtUsd(point.valueUsd)} hidden={hidden} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function ValueMissing({ data, copy }: { data: BankValueOverTime; copy: Copy }) {
  const { t } = copy;
  const missing = valueMissingOf(data.points);
  if (missing.count === 0) return null;
  return (
    <div className="money-note" data-label="value-missing" data-count={missing.count}>
      <p>{t('Pnl missing points', { count: String(missing.count) })}</p>
      <ul>
        {missing.coins.map((assetId) => (
          <li key={assetId} data-asset={assetId} data-reason="no_price">
            {t('Missing no price', { asset: assetId })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Where the change in value came from (J-portfolio-05 #6): the start, plus deposits, less withdrawals and fees, plus
 * other money in and out, plus the market move, is the end. The bank works the market move out as the remainder, so the
 * lines always add up; when any part has no price, none is shown as a figure.
 */
function BridgeCard({ data, hidden, copy }: { data: BankValueOverTime; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const { bridge } = data;
  return (
    <section className="money-card" aria-label={t('Bridge')}>
      <header className="money-card__head">
        <h2>{t('Bridge')}</h2>
      </header>
      <p className="money-note">{t('Bridge range', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) })}</p>
      <table className="money-table" data-bridge="value">
        <tbody>
          {BRIDGE_LEGS.map(({ leg, sign }) => {
            const value = bridgeValue(bridge, leg);
            const shown = signedLine(value, sign);
            return (
              <tr key={leg} data-leg={leg} data-usd={value ?? 'unknown'}>
                <th scope="row">{t(LEG_COPY[leg])}</th>
                <td className="money-num">
                  {shown === null ? (
                    t('Not known')
                  ) : (
                    <Amount value={fmtUsd(shown, { showPlus: sign !== 0 && leg !== 'opening' })} hidden={hidden} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {bridge.missing.length > 0 ? (
        <p className="money-note" data-label="bridge-missing">
          {t('Bridge unknown', { assets: bridge.missing.map((item) => item.assetId).join(', ') })}
        </p>
      ) : null}
      <p className="money-note">{t('Bridge rule')}</p>
    </section>
  );
}

/**
 * What the customer's money (main account and Spaces) was worth over the range the P&L cards use, and the bridge between
 * its ends. Read from `bank.portfolio.valueOverTime`; a moment with a coin that had no price is a gap, never zero.
 */
export function ValueOverTimeCards({ range, hidden }: { range: { from: string; to?: string } | null; hidden: boolean }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { timeZone } = usePreferences();
  const result = useValueOverTime(range);
  const points = useMemo(() => (result.status === 'ready' ? valueLine(result.data.points) : []), [result]);

  let body;
  if (range === null || result.status === 'empty') {
    body = <p className="money-note">{t('Range nothing yet')}</p>;
  } else if (result.status === 'loading') {
    body = <Skeleton width="100%" height={LINE_H} className="bg-field" />;
  } else if (result.status === 'error') {
    body = (
      <StateBlock
        kind="error"
        className="money-state"
        title={t('Value over time unreadable')}
        onRetry={result.retry}
        retryLabel={t('Try again')}
      />
    );
  } else if (result.status === 'refused') {
    const own = VALUE_REFUSAL[result.code];
    const words = refusalCopy(result.code);
    body = (
      <p className="money-note" data-refused={result.code}>
        {own ? t(own) : `${words.title}. ${words.body ?? ''}`} {words.reference ?? ''}
      </p>
    );
  } else {
    const data = result.data;
    body = (
      <>
        <TimeLine
          points={points}
          from={data.from}
          to={data.to}
          label={t('Value chart label', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) })}
          chart="value-over-time"
          signed={false}
          hidden={hidden}
          copy={copy}
        />
        <ValueMissing data={data} copy={copy} />
        <p className="money-note" data-value-interval={data.interval}>
          {t(INTERVAL_COPY[data.interval])}
        </p>
        <ValueRows data={data} hidden={hidden} copy={copy} />
      </>
    );
  }

  return (
    <>
      <section className="money-card" aria-label={t('Value over time')}>
        <header className="money-card__head">
          <h2>{t('Value over time')}</h2>
        </header>
        {body}
        <p className="money-note">{t('Value over time rule')}</p>
      </section>
      {result.status === 'ready' && range !== null ? <BridgeCard data={result.data} hidden={hidden} copy={copy} /> : null}
    </>
  );
}
