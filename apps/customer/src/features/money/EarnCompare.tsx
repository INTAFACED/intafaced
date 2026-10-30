import { useState } from 'react';
import type { z } from 'zod';
import { amount, bps, Section } from './components';
import type { earnPoolSchema } from './contracts';
import { earnPoolCopy } from './earn-pool-copy';
import { COMPARE_MAX, rowDiffers, togglePick } from './earn-rate-history';
import './earn-pool.css';

export type EarnPool = z.infer<typeof earnPoolSchema>;
type Copy = ReturnType<typeof earnPoolCopy.useCopy>['t'];

/** The link to one pool's own page (`/bank/earn/pool?id=`). */
export const poolHref = (poolId: string) => `/bank/earn/pool?id=${encodeURIComponent(poolId)}`;

/**
 * What a pool publishes, one row per term, in the bank's words (BK-earn-02, BK-earn-05). The same rows make the pool
 * page's facts and the side-by-side table, so the two never disagree. A figure the bank returned as null reads "not
 * set", never zero.
 */
export function poolFactRows(pool: EarnPool, t: Copy): Array<{ key: string; label: string; value: string }> {
  return [
    { key: 'rate', label: t('rowRate'), value: bps(pool.aprBps) },
    { key: 'term', label: t('rowTerm'), value: pool.termDays === null ? t('flexibleTerm') : t('termDays', { days: pool.termDays }) },
    {
      key: 'program',
      label: t('rowProgram'),
      value: pool.unbondingDays === null ? t('programSavings') : t('programStaking'),
    },
    {
      key: 'lock',
      label: t('rowLock'),
      value:
        pool.termDays !== null
          ? t('lockDays', { days: pool.termDays })
          : pool.unbondingDays !== null
            ? t('unbondingLock', { days: pool.unbondingDays })
            : t('noLock'),
    },
    {
      key: 'unbonding',
      label: t('rowUnbonding'),
      value: pool.unbondingDays === null ? t('noUnbonding') : t('unbondingDays', { days: pool.unbondingDays }),
    },
    { key: 'payout', label: t('rowPayout'), value: t('everyDay') },
    { key: 'compounding', label: t('rowCompounding'), value: t('simple') },
    { key: 'minimum', label: t('rowMinimum'), value: amount(pool.minDeposit, pool.assetId) },
    { key: 'capacity', label: t('rowCapacity'), value: pool.capacity === null ? t('capacityNotSet') : amount(pool.capacity, pool.assetId) },
    { key: 'paidIn', label: t('rowPaidIn'), value: pool.rewardAssetId },
    {
      key: 'bands',
      label: t('rowBands'),
      value:
        pool.rateBands === null
          ? t('bandsNotSet')
          : pool.rateBands.map((band) => `${amount(band.from, pool.assetId)}: ${bps(band.rateBps)}`).join(' · '),
    },
    {
      key: 'commission',
      label: t('rowCommission'),
      value: pool.commissionBps === null ? t('commissionNotSet') : bps(pool.commissionBps),
    },
    { key: 'yield', label: t('rowYield'), value: t('reserve') },
  ];
}

/**
 * Pools side by side (BK-earn-05, J-bank-08 #1): the person picks two to four of the pools the bank lists and reads
 * their terms in one table, with the cells that differ marked. A fifth pick is refused with the reason; every column
 * opens its pool's own page.
 */
export function EarnCompare({ pools }: { pools: EarnPool[] }) {
  const { t } = earnPoolCopy.useCopy();
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = picked.map((id) => pools.find((pool) => pool.id === id)).filter((pool): pool is EarnPool => pool !== undefined);
  const full = chosen.length >= COMPARE_MAX;
  const columns = chosen.map((pool) => poolFactRows(pool, t));
  return (
    <div data-testid="earn-compare">
      <Section title={t('compareTitle')} description={t('compareDescription')}>
        <fieldset className="money-earn-compare__picker">
          <legend className="money-visually-hidden">{t('compareTitle')}</legend>
          {pools.map((pool) => {
            const on = picked.includes(pool.id);
            return (
              <label key={pool.id} className="money-check money-earn-compare__pick">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!on && full}
                  aria-label={t('comparePick', { name: pool.name })}
                  data-pool={pool.id}
                  onChange={() => setPicked((current) => togglePick(current, pool.id))}
                />
                <span lang="und" dir="auto">
                  {pool.name}
                </span>
              </label>
            );
          })}
        </fieldset>
        {full && (
          <p className="money-caption" data-testid="earn-compare-full">
            {t('compareMax')}
          </p>
        )}
        {chosen.length < 2 ? (
          <p className="money-caption" data-testid="earn-compare-few">
            {t('compareFew')}
          </p>
        ) : (
          <div className="money-table-scroll">
            <table className="money-earn-compare__table" data-testid="earn-compare-table">
              <caption className="money-caption">{t('compareCaption')}</caption>
              <thead>
                <tr>
                  <td />
                  {chosen.map((pool) => (
                    <th scope="col" key={pool.id} data-pool={pool.id}>
                      <a className="text-link" href={poolHref(pool.id)} aria-label={t('compareOpen', { name: pool.name })}>
                        <span lang="und" dir="auto">
                          {pool.name}
                        </span>
                      </a>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {columns[0]!.map((row, index) => {
                  const values = columns.map((column) => column[index]!.value);
                  const differs = rowDiffers(values);
                  return (
                    <tr key={row.key} data-row={row.key} data-differs={differs ? 'true' : 'false'}>
                      <th scope="row">
                        {row.label}
                        {differs && <span className="money-earn-compare__differs"> · {t('differs')}</span>}
                      </th>
                      {values.map((value, column) => (
                        <td key={chosen[column]!.id} data-pool={chosen[column]!.id}>
                          {value}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
