import { useState } from 'react';
import { moneyCopy } from './copy';
import { Button, RefusalBox, Segmented } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { dec, fmtAmount, refusalCopy } from './deps';
import { useValueText } from './display-unit';
import { VALUE_REFUSAL } from './pnl/ValueOverTime';
import { Shown } from './money-parts';
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
  if (result.status === 'loading') body = <Skeleton shape="rows" count={2} />;
  else if (result.status === 'error')
    body = (
      <div data-testid="money-state" data-slot="state-block" data-kind="error" className="lt-stack">
        <RefusalBox refusal={{ variant: 'unreachable', title: t('Change unreadable'), body: '' }} />
        <div className="lt-actions">
          <Button tone="secondary" onClick={result.retry}>
            {t('Try again')}
          </Button>
        </div>
      </div>
    );
  else if (result.status === 'refused') {
    // The bank's own value-history refusals have their own words (pick a later start, history down); others the shared ones.
    const own = VALUE_REFUSAL[result.code];
    const words = refusalCopy(result.code);
    body = (
      <p data-testid="money-note" className="lt-hint" data-refused={result.code}>
        {own ? t(own) : `${words.title}. ${words.body ?? ''}`} {words.reference ?? ''}
      </p>
    );
  } else if (result.status === 'empty' || result.data.rows.length === 0)
    body = (
      <p data-testid="money-note" className="lt-hint">
        {t('Change nothing held')}
      </p>
    );
  else body = <ChangeTable data={result.data} hidden={hidden} copy={copy} timeZone={timeZone} />;

  return (
    <section data-testid="money-card" className="lt-stack" aria-label={t('Holdings change')}>
      <header data-testid="money-card__head" className="lt-title-row">
        <h2>{t('Holdings change')}</h2>
      </header>
      <Segmented
        label={t('Change range')}
        value={key}
        onChange={setKey}
        options={CHANGE_RANGES.map((range) => ({ value: range.key, label: t(range.label) }))}
      />
      {body}
      <p data-testid="money-note" className="lt-hint">
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
      className="lt-table"
      aria-label={t('Holdings change table', { from: stamp(data.from, timeZone), to: stamp(data.to, timeZone) })}
    >
      <thead>
        <tr>
          <th scope="col">{t('Coin')}</th>
          <th scope="col" data-align="end">
            {t('Change then')}
          </th>
          <th scope="col" data-align="end">
            {t('Change now')}
          </th>
          <th scope="col" data-align="end">
            {t('Change amount')}
          </th>
          <th scope="col" data-align="end">
            {t('Change value then')}
          </th>
          <th scope="col" data-align="end">
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
              <td data-align="end" data-label={t('Change then')}>
                {none ? t('No holding yet') : <Shown slot="amount" text={`${fmtAmount(row.startAmount)} ${row.assetId}`} hidden={hidden} />}
              </td>
              <td data-align="end" data-label={t('Change now')}>
                <Shown slot="amount" text={`${fmtAmount(row.endAmount)} ${row.assetId}`} hidden={hidden} />
              </td>
              <td data-align="end" data-label={t('Change amount')}>
                <Shown slot="amount" text={signedAmount(row.change, row.assetId)} hidden={hidden} />
              </td>
              <td data-align="end" data-label={t('Change value then')}>
                {none ? (
                  '—'
                ) : row.startValueUsd === null ? (
                  t('Not priced')
                ) : (
                  <Shown slot="amount" text={value(row.startValueUsd) ?? '—'} hidden={hidden} />
                )}
              </td>
              <td data-align="end" data-label={t('Change value now')}>
                {row.endValueUsd === null ? t('Not priced') : <Shown slot="amount" text={value(row.endValueUsd) ?? '—'} hidden={hidden} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
