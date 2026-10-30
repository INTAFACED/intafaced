import type { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { Button, Loading } from '../../shared/ui';
import { bps, date, funds, NoRows, Section, useBankRead, type ActionSpec } from './components';
import type { earnPoolPageSchema, positionSchema, rateHistorySchema } from './contracts';
import { earnPoolCopy } from './earn-pool-copy';
import { poolFactRows } from './EarnCompare';
import { stepChart, utcDay as day } from './earn-rate-history';
import {
  AccrualState,
  AutoEarn,
  EarnCalculator,
  FixedTerm,
  PayoutSchedule,
  PoolDeposit,
  PoolEarned,
  PoolWithdraw,
} from './EarnPoolActions';
import './earn-pool.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type History = z.infer<typeof rateHistorySchema>;
type Position = z.infer<typeof positionSchema>;
type Pool = z.infer<typeof earnPoolPageSchema>;
type Open = (spec: ActionSpec) => void;
const HISTORY_ROWS = 200;
const POSITIONS = 50;
const CHART_W = 600;
const CHART_H = 160;

function Refused({ failure, retry }: { failure: Failed; retry: () => void }) {
  const { t } = earnPoolCopy.useCopy();
  const words = failure.code === 'bank.pool_not_found' ? t('notFound') : t('readFailed');
  return (
    <div role="alert" className="error-text" data-code={failure.code ?? ''}>
      <p>
        {words}
        {failure.code ? ` ${t('reference', { code: failure.code })}` : ''}
      </p>
      <Button variant="ghost" onClick={retry}>
        {t('retry')}
      </Button>
    </div>
  );
}

/**
 * `/bank/earn/pool?id=<pool>` (BK-earn-02, BK-earn-05, J-bank-08 #1 and #2): one pool's published terms, how its rate
 * has changed, and the person's savings in it with the rate in force when each was opened, each saving's payout
 * schedule and, on a fixed term, its lock date and auto-renew choice (BK-earn-03, J-bank-08 #4 and #5). Every line is the bank's
 * answer (`earn.pool`, `earn.rateHistory`, `earn.positions`); a blank owner table reads "not set".
 */
export function EarnPool({ poolId, open }: { poolId: string | null; open: Open }) {
  const { t } = earnPoolCopy.useCopy();
  if (!poolId) {
    return (
      <NoRows title={t('noPool')}>
        <a className="text-link" href="/bank/earn">
          {t('back')}
        </a>
      </NoRows>
    );
  }
  return <PoolBody poolId={poolId} open={open} />;
}

function PoolBody({ poolId, open }: { poolId: string; open: Open }) {
  const { t } = earnPoolCopy.useCopy();
  const pool = useBankRead('earn.pool', { poolId });
  const history = useBankRead('earn.rateHistory', { poolId, limit: HISTORY_ROWS });
  const positions = useBankRead('earn.positions', { limit: POSITIONS, poolId });
  if (pool.resource.status === 'loading') return <Loading />;
  if (pool.resource.status === 'failed') return <Refused failure={pool.resource.failure} retry={pool.reload} />;
  const data = pool.resource.data;
  return (
    <div data-testid="earn-pool" data-pool={data.id} data-status={data.status}>
      <p className="money-caption">
        <a className="text-link" href="/bank/earn">
          {t('back')}
        </a>
      </p>
      <Section title={data.name} description={t('factsLead')}>
        <p className="money-caption" data-testid="earn-pool-status" data-status={data.status}>
          {data.assetId} · {data.status === 'open' ? t('open') : t('closed')}
        </p>
        <h3>{t('factsTitle')}</h3>
        <dl className="money-earn-facts" data-testid="earn-pool-facts">
          {poolFactRows(data, t).map((row) => (
            <div key={row.key} data-fact={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </Section>
      {data.unbondingDays !== null && (
        <>
          <Section title={t('stakingTitle')} description={t('stakingLead')}>
            <ol className="money-earn-states" data-testid="earn-staking" data-unbonding-days={data.unbondingDays}>
              <li data-state="staked">{t('stateStaked')}</li>
              <li data-state="unbonding">{t('stateUnbonding', { days: data.unbondingDays })}</li>
              <li data-state="available">{t('stateAvailable')}</li>
            </ol>
          </Section>
          <Section title={t('riskTitle')}>
            <RiskDisclosure />
          </Section>
        </>
      )}
      <Section title={t('historyTitle')} description={t('historyLead')}>
        {history.resource.status === 'loading' && <Loading />}
        {history.resource.status === 'failed' && <Refused failure={history.resource.failure} retry={history.reload} />}
        {history.resource.status === 'ready' && <RateHistory history={history.resource.data} />}
      </Section>
      <Section title={t('saveTitle')}>
        <EarnCalculator pool={data} />
        <PoolDeposit pool={data} open={open} />
      </Section>
      <Section
        title={t('yoursTitle')}
        actions={
          <Button variant="ghost" onClick={positions.reload}>
            {t('refresh')}
          </Button>
        }
      >
        {positions.resource.status === 'loading' && <Loading />}
        {positions.resource.status === 'failed' && <Refused failure={positions.resource.failure} retry={positions.reload} />}
        {positions.resource.status === 'ready' && <Yours pool={data} positions={positions.resource.data} open={open} />}
        <PoolEarned pool={data} />
      </Section>
      <Section title={t('autoTitle')}>
        <AutoEarn pool={data} open={open} />
      </Section>
    </div>
  );
}

/**
 * The owner's staking risk wording (BK-earn-04, J-bank-08 #6), as the bank publishes it. Unpublished says so and never
 * reads as "no risk"; the line under it is what the bank's own records already make true of every staking-style pool.
 */
function RiskDisclosure() {
  const { t } = earnPoolCopy.useCopy();
  const wording = useBankRead('earn.riskDisclosure', undefined);
  if (wording.resource.status === 'loading') return <Loading />;
  const failure = wording.resource.status === 'failed' ? wording.resource.failure : null;
  if (failure && failure.code !== 'bank.earn_risk_wording_unset') return <Refused failure={failure} retry={wording.reload} />;
  const published = wording.resource.status === 'ready' ? wording.resource.data : null;
  return (
    <div data-testid="earn-risk-disclosure" data-state={published ? 'published' : 'unset'}>
      {published ? (
        <dl className="money-earn-facts">
          <div data-risk="slashing">
            <dt>{t('riskSlashing')}</dt>
            <dd>{published.slashing}</dd>
          </div>
          <div data-risk="ownership">
            <dt>{t('riskOwnership')}</dt>
            <dd>{published.ownership}</dd>
          </div>
        </dl>
      ) : (
        <p className="money-caption" data-code="bank.earn_risk_wording_unset">
          {t('riskUnset')}
        </p>
      )}
      <p className="money-caption">{t('riskKnown')}</p>
    </div>
  );
}

/** The recorded rates as a step chart and a dated table. Before the first record there is nothing to draw, and it says so. */
function RateHistory({ history }: { history: History }) {
  const { t } = earnPoolCopy.useCopy();
  if (history.changes.length === 0) {
    return (
      <p className="money-caption" data-testid="earn-rate-history" data-steps="0">
        {t('noHistory', { rate: bps(history.currentBps) })}
      </p>
    );
  }
  const chart = stepChart(history.changes, Date.now(), CHART_W, CHART_H);
  const first = history.changes[0]!;
  return (
    <div data-testid="earn-rate-history" data-steps={history.changes.length}>
      {chart && (
        <figure className="money-earn-history">
          <figcaption>{t('historyChart')}</figcaption>
          <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={t('historyChart')} preserveAspectRatio="none">
            <polyline points={chart.points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {chart.marks.map((mark) => (
              <circle key={mark.effectiveAt} cx={mark.x} cy={mark.y} r="3" fill="currentColor" data-step={mark.rateBps} />
            ))}
          </svg>
        </figure>
      )}
      {history.earlier ? (
        <p className="money-caption">{t('earlierHidden', { count: history.changes.length })}</p>
      ) : (
        <p className="money-caption" data-testid="earn-rate-history-start">
          {t('noEarlierHistory', { date: day(first.effectiveAt) })}
        </p>
      )}
      <p className="money-caption">
        <strong>{t('nowRate', { rate: bps(history.currentBps) })}</strong>
      </p>
      <table className="money-earn-history__table" data-testid="earn-rate-history-table">
        <caption className="money-visually-hidden">{t('historyTable')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('historyDate')}</th>
            <th scope="col">{t('historyRate')}</th>
            <th scope="col">{t('historyReason')}</th>
          </tr>
        </thead>
        <tbody>
          {[...history.changes].reverse().map((change) => (
            <tr key={change.effectiveAt} data-rate={change.rateBps} data-at={change.effectiveAt}>
              <td>{day(change.effectiveAt)}</td>
              <td>{bps(change.rateBps)}</td>
              <td>
                {/* Only the first record has no reason: every approved change carries one. */}
                {change.reason ?? t('historyOpened')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The person's savings in this pool, each with the rate the bank's record shows in force when it was opened. */
function Yours({ pool, positions, open }: { pool: Pool; positions: Position[]; open: Open }) {
  const { t } = earnPoolCopy.useCopy();
  if (!positions.length) return <p className="money-caption">{t('yoursNone')}</p>;
  return (
    <>
      {positions.map((position) => {
        return (
          <article className="money-record" key={position.id} data-testid="earn-pool-position" data-position={position.id}>
            <header>
              <div>
                <p className="money-caption">{t('opened', { date: date(position.openedAt) })}</p>
                <p className="money-caption" data-testid="earn-pool-rate-at-open" data-bps={position.rateAtOpenBps ?? ''}>
                  {position.rateAtOpenBps === null ? t('rateAtOpenUnknown') : t('rateAtOpen', { rate: bps(position.rateAtOpenBps) })}
                </p>
              </div>
              <strong className="numeric">{funds(position.principal, position.assetId)}</strong>
            </header>
            <AccrualState position={position} />
            <FixedTerm pool={pool} position={position} open={open} />
            <PayoutSchedule pool={pool} position={position} />
            <PoolWithdraw pool={pool} position={position} open={open} />
          </article>
        );
      })}
    </>
  );
}
