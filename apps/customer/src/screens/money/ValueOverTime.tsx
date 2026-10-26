import { useMemo, type ReactNode } from 'react';
import { moneyCopy } from './copy';
import { Amount, Skeleton, StateBlock, fmtUsd, refusalCopy } from './deps';
import { useValueOverTime } from './pnl-source';
import { offsetMinutes, rangeFromQuery, rangeKey, resolveRange } from './pnl-time-model';
import { INTERVAL_COPY, LINE_H, RangePicker, TimeLine } from './time-line';
import { stamp } from './time';
import {
  BANK_VALUE_HISTORY_TOO_LARGE,
  BANK_VALUE_HISTORY_UNAVAILABLE,
  BANK_VALUE_RANGE_INVALID,
  BANK_VALUE_RANGE_TOO_LONG,
  BRIDGE_LEGS,
  VALUE_PRICES_DOWN,
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
export const VALUE_REFUSAL: Record<
  string,
  'Pnl range refused' | 'Pnl range too long' | 'Pnl prices unavailable' | 'Value history too large' | 'Value history unavailable'
> = {
  [BANK_VALUE_RANGE_INVALID]: 'Pnl range refused',
  [BANK_VALUE_RANGE_TOO_LONG]: 'Pnl range too long',
  [VALUE_PRICES_DOWN]: 'Pnl prices unavailable',
  [BANK_VALUE_HISTORY_TOO_LARGE]: 'Value history too large',
  [BANK_VALUE_HISTORY_UNAVAILABLE]: 'Value history unavailable',
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
      <table data-testid="money-table" className="money-table" aria-label={t('Value points table')}>
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
    <div data-testid="money-note" className="money-note" data-label="value-missing" data-count={missing.count}>
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
function BridgeCard({ result, hidden, copy }: { result: ValueRead; hidden: boolean; copy: Copy }) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  if (result.status !== 'ready') {
    return (
      <section data-testid="money-card" className="money-card" aria-label={t('Bridge')}>
        <header data-testid="money-card__head" className="money-card__head">
          <h2>{t('Bridge')}</h2>
        </header>
        {result.note}
        <p data-testid="money-note" className="money-note">
          {t('Bridge rule')}
        </p>
      </section>
    );
  }
  const { data } = result;
  const { bridge } = data;
  return (
    <section data-testid="money-card" className="money-card" aria-label={t('Bridge')}>
      <header data-testid="money-card__head" className="money-card__head">
        <h2>{t('Bridge')}</h2>
      </header>
      <p data-testid="money-note" className="money-note">
        {t('Bridge range', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) })}
      </p>
      <table data-testid="money-table" className="money-table" data-bridge="value">
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
        <p data-testid="money-note" className="money-note" data-label="bridge-missing">
          {t('Bridge unknown', { assets: bridge.missing.map((item) => item.assetId).join(', ') })}
        </p>
      ) : null}
      <p data-testid="money-note" className="money-note">
        {t('Bridge rule')}
      </p>
    </section>
  );
}

/** What the read gave: the answer, or the one note both cards show in its place. */
type ValueRead = { status: 'ready'; data: BankValueOverTime } | { status: 'other'; note: ReactNode };

/**
 * What the customer's money (main account and Spaces) was worth over the range in the link, and the bridge between its
 * ends. Read from the bank alone, so it shows whether or not the lot book has trades or can be read; `picker` when the
 * profit and loss cards (which carry the range switch) are not on the page. `first`: the book's first trade, where
 * "All" starts, or null when there is none to read.
 */
export function ValueOverTimeCards({
  search,
  first,
  picker,
  hidden,
}: {
  search: string;
  first: string | null;
  picker: boolean;
  hidden: boolean;
}) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { timeZone } = usePreferences();
  const offset = useMemo(() => offsetMinutes(timeZone, Date.now()), [timeZone]);
  const parsed = rangeFromQuery(search);
  const askKey = rangeKey(parsed);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- kept by the range alone: `view=` or `by=` keeps the same read
  const ask = useMemo(() => parsed, [askKey]);
  // Read the clock only when the range changes, so a preset's start stays put while the page is open.
  const range = useMemo(() => resolveRange(ask, Date.now(), offset, first), [ask, offset, first]);
  const result = useValueOverTime(range);
  const points = useMemo(() => (result.status === 'ready' ? valueLine(result.data.points) : []), [result]);

  let read: ValueRead;
  if (ask.kind === 'invalid') {
    read = {
      status: 'other',
      note: (
        <p data-testid="money-note" className="money-note">
          {t('Range invalid')}
        </p>
      ),
    };
  } else if (range === null || result.status === 'empty') {
    read = {
      status: 'other',
      note: (
        <p data-testid="money-note" className="money-note">
          {t('Value all needs a start')}
        </p>
      ),
    };
  } else if (result.status === 'loading') {
    read = { status: 'other', note: <Skeleton width="100%" height={LINE_H} className="bg-field" /> };
  } else if (result.status === 'error') {
    read = {
      status: 'other',
      note: (
        <StateBlock
          kind="error"
          testId="money-state"
          className="money-state"
          title={t('Value over time unreadable')}
          onRetry={result.retry}
          retryLabel={t('Try again')}
        />
      ),
    };
  } else if (result.status === 'refused') {
    const own = VALUE_REFUSAL[result.code];
    const words = refusalCopy(result.code);
    read = {
      status: 'other',
      note: (
        <p data-testid="money-note" className="money-note" data-refused={result.code}>
          {own ? t(own) : `${words.title}. ${words.body ?? ''}`} {words.reference ?? ''}
        </p>
      ),
    };
  } else {
    read = { status: 'ready', data: result.data };
  }

  return (
    <>
      <section data-testid="money-card" className="money-card" aria-label={t('Value over time')}>
        <header data-testid="money-card__head" className="money-card__head">
          <h2>{t('Value over time')}</h2>
        </header>
        {picker ? <RangePicker key={search} search={search} offset={offset} copy={copy} /> : null}
        {read.status === 'ready' ? (
          <>
            <TimeLine
              points={points}
              from={read.data.from}
              to={read.data.to}
              label={t('Value chart label', { from: stamp(read.data.from, timeZone), to: stamp(read.data.to, timeZone) })}
              chart="value-over-time"
              signed={false}
              hidden={hidden}
              copy={copy}
            />
            <ValueMissing data={read.data} copy={copy} />
            <p data-testid="money-note" className="money-note" data-value-interval={read.data.interval}>
              {t(INTERVAL_COPY[read.data.interval])}
            </p>
            <ValueRows data={read.data} hidden={hidden} copy={copy} />
          </>
        ) : (
          read.note
        )}
        <p data-testid="money-note" className="money-note">
          {t('Value over time rule')}
        </p>
      </section>
      <BridgeCard result={read} hidden={hidden} copy={copy} />
    </>
  );
}
