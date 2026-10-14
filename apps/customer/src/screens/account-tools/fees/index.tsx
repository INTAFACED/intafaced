import { useMemo } from 'react';
import { Skeleton, StateBlock } from '@intafaced/ui';
import type { ScreenProps } from '../../../app/screen-types';
import { refusalCopy, useMarkets } from '../../../data';
import { rankForOwner, accountPerks } from '../../../features/account/rank-perks-api';
import { useSession } from '../../../features/session/session';
import { useResource } from '../../../shared/resource';
import { AccountFrame, ToolsHeading } from '../shared/AccountFrame';
import { ReadFailure } from '../shared/failure';
import { feesCopy } from './copy';
import { DASH, discountPercent, rateRows, readFees } from './model';

/**
 * Fee schedule (M9, OKX "Fee schedule"): your rank discount, the fee levels (dashes until the owner sets them) and the
 * published maker and taker rate for each market. 30-day volume is a dash because the back end does not count it yet.
 */
export default function FeesScreen(_props: ScreenProps) {
  const { t } = feesCopy.useCopy();
  return (
    <AccountFrame here="fees">
      <ToolsHeading title={t('title')} line={t('line')} />
      <YourLevel />
      <section className="tools-card" aria-labelledby="levels-title">
        <h2 id="levels-title" className="tools-h2">
          {t('levels title')}
        </h2>
        <div className="tools-scroll">
          <table className="tools-table tools-table--levels">
            <thead>
              <tr>
                <th scope="col">{t('col level')}</th>
                <th scope="col" className="tools-table__num">
                  {t('col volume')}
                </th>
                <th scope="col" className="tools-table__num">
                  {t('col maker')}
                </th>
                <th scope="col" className="tools-table__num">
                  {t('col taker')}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t('levels none')}</th>
                <td className="tools-table__num">{t('levels none')}</td>
                <td className="tools-table__num">{t('levels none')}</td>
                <td className="tools-table__num">{t('levels none')}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="tools-foot">{t('levels caption')}</p>
      </section>
      <MarketRates />
    </AccountFrame>
  );
}

function YourLevel() {
  const { t } = feesCopy.useCopy();
  const { api, userId } = useSession();
  const rankSchema = useMemo(() => rankForOwner(userId ?? ''), [userId]);
  const key = userId ?? 'none';
  const rank = useResource((signal) => api.query('identity', 'rank.get', undefined, rankSchema, { signal }), `fees-rank:${key}`);
  const perks = useResource((signal) => api.query('identity', 'rank.perks', undefined, accountPerks, { signal }), `fees-perks:${key}`);
  const loading = rank.resource.status === 'loading' || perks.resource.status === 'loading';
  const failed = rank.resource.status === 'failed' ? rank.resource : perks.resource.status === 'failed' ? perks.resource : null;
  let discount: { value: string; caption: string } | null = null;
  if (rank.resource.status === 'ready' && perks.resource.status === 'ready') {
    const percent = discountPercent(perks.resource.data.feeDiscountBps);
    discount = {
      value: percent,
      caption:
        perks.resource.data.feeDiscountBps > 0 ? t('discount caption', { rank: rank.resource.data.rank }) : t('discount caption none'),
    };
  }
  return (
    <section className="tools-stats" aria-label={t('your level')}>
      <Stat label={t('your level')} value={DASH} caption={t('level caption')} />
      <Stat label={t('your volume')} value={DASH} caption={t('volume caption')} />
      {failed ? (
        <div className="tools-stat">
          <p className="tools-stat__label">{t('your discount')}</p>
          <ReadFailure
            failure={failed.failure}
            retry={() => {
              rank.reload();
              perks.reload();
            }}
            title={t('rank failed')}
            retryLabel={t('retry')}
            className="tools-stat__state"
          />
        </div>
      ) : loading || !discount ? (
        <div className="tools-stat" role="status" aria-label={t('rank loading')}>
          <p className="tools-stat__label">{t('your discount')}</p>
          <Skeleton height={32} width={96} />
          <Skeleton height={16} width="100%" />
        </div>
      ) : (
        <Stat label={t('your discount')} value={discount.value} caption={discount.caption} tone="lime" />
      )}
    </section>
  );
}

function Stat({ label, value, caption, tone }: { label: string; value: string; caption: string; tone?: 'lime' }) {
  return (
    <div className="tools-stat">
      <p className="tools-stat__label">{label}</p>
      <p className={tone === 'lime' ? 'tools-stat__value tools-stat__value--lime' : 'tools-stat__value'}>{value}</p>
      <p className="tools-stat__caption">{caption}</p>
    </div>
  );
}

function MarketRates() {
  const { t } = feesCopy.useCopy();
  const { api, userId } = useSession();
  const fees = useResource((signal) => readFees(api, signal), `fees:${userId ?? 'none'}`);
  const markets = useMarkets({ includeClosed: true });
  const rows = useMemo(
    () => (fees.resource.status === 'ready' && markets.status === 'ready' ? rateRows(markets.data, fees.resource.data) : []),
    [fees.resource, markets],
  );
  let body;
  if (fees.resource.status === 'failed')
    body = <ReadFailure failure={fees.resource.failure} retry={fees.reload} title={t('markets failed')} retryLabel={t('retry')} />;
  else if (markets.status === 'error')
    body = <StateBlock kind="error" title={t('markets failed')} onRetry={markets.retry} retryLabel={t('retry')} />;
  else if (markets.status === 'refused') {
    const words = refusalCopy(markets.code);
    body = <StateBlock kind="refused" title={words.title} body={words.body} code={words.reference} action={words.action} />;
  } else if (markets.status === 'empty') body = <StateBlock kind="empty" title={t('markets empty title')} body={t('markets empty body')} />;
  else if (fees.resource.status === 'loading' || markets.status !== 'ready')
    body = <StateBlock kind="loading" rows={5} rowHeight={40} label={t('markets loading')} />;
  else
    body = (
      <>
        <div className="tools-scroll tools-scroll--tall">
          <table className="tools-table" aria-label={t('markets label')}>
            <thead>
              <tr>
                <th scope="col">{t('col market')}</th>
                <th scope="col" className="tools-table__num">
                  {t('col maker')}
                </th>
                <th scope="col" className="tools-table__num">
                  {t('col taker')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.symbol}>
                  <th scope="row">{row.market}</th>
                  <td className="tools-table__num">{row.maker}</td>
                  <td className="tools-table__num">{row.taker}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.some((row) => row.unset) ? <p className="tools-foot">{t('markets caption')}</p> : null}
        <p className="tools-foot">{t('maker note')}</p>
        <p className="tools-foot tools-foot--tight">{t('taker note')}</p>
      </>
    );
  return (
    <section className="tools-card" aria-labelledby="markets-title">
      <h2 id="markets-title" className="tools-h2">
        {t('markets title')}
      </h2>
      {body}
    </section>
  );
}
