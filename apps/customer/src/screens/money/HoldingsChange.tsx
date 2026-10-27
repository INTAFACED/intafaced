import { useState } from 'react';
import { moneyCopy } from './copy';
import { Amount, Skeleton, StateBlock, dec, fmtAmount, refusalCopy } from './deps';
import { useValueText } from './display-unit';
import { VALUE_REFUSAL } from './ValueOverTime';
import { CHANGE_RANGES, useHoldingsChange, type BankHoldingsChange, type ChangeRangeKey } from './holdings-change-source';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/** "+0.5 BTC", "−100 USDT", "0 USDT": the change in the coin's own unit, signed. */
function signedAmount(change: string, asset: string): string {
  return `${(dec(change) ?? 0n) > 0n ? '+' : ''}${fmtAmount(change)} ${asset}`;
}

/**
 * Holdings change over a period (PF-balances-02, J-portfolio-06 #3): for each coin, what was held at the start of the range
 * and now, what rose and what fell, and its value at both ends. A start with nothing held says so; an end with no price
 * says "not priced", never zero.
 */
export function HoldingsChange({ hidden }: { hidden: boolean }) {
  const copy = moneyCopy.useCopy();
  const { t } = copy;
  const { timeZone } = usePreferences();
  const [key, setKey] = useState<ChangeRangeKey>('7d');
  const result = useHoldingsChange(CHANGE_RANGES.find((range) => range.key === key)!.hours);

  let body;
  if (result.status === 'loading') body = <Skeleton width="100%" height={96} className="bg-field" />;
  else if (result.status === 'error')
    body = (
      <StateBlock
        kind="error"
        testId="money-state"
        className="money-state"
        title={t('Change unreadable')}
        onRetry={result.retry}
        retryLabel={t('Try again')}
      />
    );
  else if (result.status === 'refused') {
    // The bank's own value-history refusals have their own words (pick a later start, history down); others the shared ones.
    const own = VALUE_REFUSAL[result.code];
    const words = refusalCopy(result.code);
    body = (
      <p data-testid="money-note" className="money-note" data-refused={result.code}>
        {own ? t(own) : `${words.title}. ${words.body ?? ''}`} {words.reference ?? ''}
      </p>
    );
  } else if (result.status === 'empty' || result.data.rows.length === 0)
    body = (
      <p data-testid="money-note" className="money-note">
        {t('Change nothing held')}
      </p>
    );
  else body = <ChangeTable data={result.data} hidden={hidden} copy={copy} timeZone={timeZone} />;

  return (
    <section data-testid="money-card" className="money-card" aria-label={t('Holdings change')}>
      <header data-testid="money-card__head" className="money-card__head">
        <h2>{t('Holdings change')}</h2>
      </header>
      <div className="money-alloc__switch" role="group" aria-label={t('Change range')}>
        {CHANGE_RANGES.map((range) => (
          <button
            key={range.key}
            type="button"
            className="money-alloc__opt"
            aria-pressed={key === range.key}
            onClick={() => setKey(range.key)}
          >
            {t(range.label)}
          </button>
        ))}
      </div>
      {body}
      <p data-testid="money-note" className="money-note">
        {t('Holdings change rule')}
      </p>
    </section>
  );
}

function ChangeTable({
  data,
  hidden,
  copy,
  timeZone,
}: {
  data: BankHoldingsChange;
  hidden: boolean;
  copy: Copy;
  timeZone: Parameters<typeof stamp>[1];
}) {
  const { t } = copy;
  const value = useValueText();
  return (
    <table
      data-testid="money-table"
      className="money-table"
      aria-label={t('Holdings change table', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) })}
    >
      <thead>
        <tr>
          <th scope="col">{t('Coin')}</th>
          <th scope="col" className="money-num">
            {t('Change then')}
          </th>
          <th scope="col" className="money-num">
            {t('Change now')}
          </th>
          <th scope="col" className="money-num">
            {t('Change amount')}
          </th>
          <th scope="col" className="money-num">
            {t('Change value then')}
          </th>
          <th scope="col" className="money-num">
            {t('Change value now')}
          </th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => {
          const none = (dec(row.startAmount) ?? 0n) === 0n;
          return (
            <tr
              key={row.assetId}
              data-change-asset={row.assetId}
              data-start={row.startAmount}
              data-end={row.endAmount}
              data-change={row.change}
            >
              <th scope="row">{row.assetId}</th>
              <td className="money-num">
                {none ? t('No holding yet') : <Amount value={`${fmtAmount(row.startAmount)} ${row.assetId}`} hidden={hidden} />}
              </td>
              <td className="money-num">
                <Amount value={`${fmtAmount(row.endAmount)} ${row.assetId}`} hidden={hidden} />
              </td>
              <td className="money-num">
                <Amount value={signedAmount(row.change, row.assetId)} hidden={hidden} />
              </td>
              <td className="money-num">
                {none ? (
                  '—'
                ) : row.startValueUsd === null ? (
                  t('Not priced')
                ) : (
                  <Amount value={value(row.startValueUsd) ?? '—'} hidden={hidden} />
                )}
              </td>
              <td className="money-num">
                {row.endValueUsd === null ? t('Not priced') : <Amount value={value(row.endValueUsd) ?? '—'} hidden={hidden} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
