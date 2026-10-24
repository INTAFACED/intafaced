import type { z } from 'zod';
import { Button, Failure, Loading } from '../../shared/ui';
import { parseAmount } from '../../shared/money';
import { amount, bps, funds, NoRows, positiveMoney, Section, useBankRead, type ActionSpec } from './components';
import { bankWrites, type poolSchema, type positionSchema } from './contracts';
import { instantSavingsCopy } from './instant-savings-copy';

type Pool = z.infer<typeof poolSchema>;
type Position = z.infer<typeof positionSchema>;
const LIMIT = 50;
const DAYS_SHOWN = 31;

/**
 * Instant-access savings on the Spaces page (BK-pots-03, J-bank-07 #5): the bank's flexible earn pools with their rate,
 * a door to open one from the account, and each of the person's savings with the interest the bank has paid, day by day.
 * A blank rate says so; every figure is the bank's answer.
 */
export function InstantSavings({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = instantSavingsCopy.useCopy();
  const pools = useBankRead('earn.pools', { limit: LIMIT });
  const positions = useBankRead('earn.positions', { limit: LIMIT });

  const openSavings = (pool: Pool) =>
    open({
      title: t('openTitle', { asset: pool.assetId }),
      procedure: 'earn.deposit',
      unit: pool.assetId,
      fields: [positiveMoney(pool.assetId)],
      facts: [
        [t('pool'), pool.name],
        [t('annualRate'), bps(pool.aprBps)],
        [t('smallest'), amount(pool.minDeposit, pool.assetId)],
      ],
      notes: [t('openNote'), t('openAnytime')],
      validate: (input) => (parseAmount(String(input.amount)) >= parseAmount(pool.minDeposit) ? null : t('belowMinimum')),
      verifyOutcome: (data, input) => {
        const returned = data as z.infer<(typeof bankWrites)['earn.deposit']>;
        return returned.positionId === input.positionId && returned.maturesAt === null;
      },
      input: (values, requestId) => ({ poolId: pool.id, positionId: requestId, amount: values.amount }),
      submit: t('open'),
    });

  const body = () => {
    if (pools.resource.status === 'loading') return <Loading />;
    if (pools.resource.status === 'failed') {
      return pools.resource.failure.code === 'bank.earn_rate_unset' ? (
        <p className="money-caption" data-testid="instant-savings-rate" data-state="unset">
          {t('rateUnset')}
        </p>
      ) : (
        <Failure result={pools.resource.failure} retry={pools.reload} />
      );
    }
    const flexible = pools.resource.data.filter((pool) => pool.kind === 'flexible');
    if (!flexible.length) return <NoRows title={t('noPools')} />;
    const held = positions.resource.status === 'ready' ? positions.resource.data : [];
    return (
      <>
        {flexible.map((pool) => (
          <article className="money-record" key={pool.id} data-testid="instant-savings-pool" data-pool={pool.id} data-asset={pool.assetId}>
            <header>
              <div>
                <h3 lang="und" dir="auto">
                  {pool.name}
                </h3>
                <p className="money-caption">{t('minimum', { amount: amount(pool.minDeposit, pool.assetId) })}</p>
              </div>
              <strong data-testid="instant-savings-rate" data-state="set" data-bps={pool.aprBps}>
                {t('rate', { rate: bps(pool.aprBps) })}
              </strong>
            </header>
            <p className="money-caption">{t('rateNote')}</p>
            <div className="actions">
              <Button variant="secondary" onClick={() => openSavings(pool)}>
                {t('open')}
              </Button>
            </div>
            {held.some((position) => position.poolId === pool.id) && (
              <Savings pool={pool} positions={held.filter((position) => position.poolId === pool.id)} open={open} />
            )}
          </article>
        ))}
        {positions.resource.status === 'failed' && <Failure result={positions.resource.failure} retry={positions.reload} />}
      </>
    );
  };

  return (
    <div data-testid="instant-savings">
      <Section title={t('title')} description={t('description')}>
        {body()}
      </Section>
    </div>
  );
}

/** An accrual day is a calendar day, not an instant: shown as itself in any zone, in the app's one date look. */
function calendarDay(day: string) {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return day;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/** The person's savings in one pool: what is saved, the interest paid on it and each paid day. */
function Savings({ pool, positions, open }: { pool: Pool; positions: Position[]; open: (spec: ActionSpec) => void }) {
  const { t } = instantSavingsCopy.useCopy();
  const history = useBankRead('earn.interestHistory', { poolId: pool.id, limit: DAYS_SHOWN });
  const withdraw = (position: Position) =>
    open({
      title: t('withdrawTitle', { amount: amount(position.principal, position.assetId) }),
      procedure: 'earn.withdraw',
      unit: position.assetId,
      facts: [
        [t('pool'), pool.name],
        [t('saved'), amount(position.principal, position.assetId)],
      ],
      notes: [t('withdrawNote')],
      verifyOutcome: (data) => {
        const returned = data as z.infer<(typeof bankWrites)['earn.withdraw']>;
        return returned.positionId === position.id && parseAmount(returned.principal) === parseAmount(position.principal);
      },
      input: () => ({ positionId: position.id }),
      submit: t('withdraw'),
    });
  return (
    <section data-testid="instant-savings-mine" aria-label={t('yours', { asset: pool.assetId })}>
      <h4>{t('yours', { asset: pool.assetId })}</h4>
      <ul className="money-list">
        {positions.map((position) => (
          <li key={position.id} data-testid="instant-savings-position" data-position={position.id}>
            <span>
              {t('saved')}: <span className="numeric">{funds(position.principal, position.assetId)}</span>
            </span>{' '}
            <Button variant="ghost" onClick={() => withdraw(position)}>
              {t('withdraw')}
            </Button>
          </li>
        ))}
      </ul>
      {history.resource.status === 'loading' && <Loading />}
      {history.resource.status === 'failed' && <Failure result={history.resource.failure} retry={history.reload} />}
      {history.resource.status === 'ready' && (
        <>
          <dl className="money-selected-details">
            <div>
              <dt>{t('earned')}</dt>
              <dd className="numeric" data-testid="instant-savings-earned" data-amount={history.resource.data.total}>
                {funds(history.resource.data.total, pool.assetId)}
              </dd>
              <dd className="money-caption">{t('earnedNote')}</dd>
            </div>
          </dl>
          <h4>{t('days')}</h4>
          {history.resource.data.days.length ? (
            <ul className="money-list">
              {history.resource.data.days.map((day) => (
                <li key={day.date} data-testid="instant-savings-day" data-date={day.date} data-amount={day.amount} data-bps={day.rateBps}>
                  {t('day', { date: calendarDay(day.date), amount: funds(day.amount, pool.assetId), rate: bps(day.rateBps) })}
                </li>
              ))}
            </ul>
          ) : (
            <p className="money-caption">{t('noDays')}</p>
          )}
          {history.resource.data.days.length >= DAYS_SHOWN && <p className="money-caption">{t('more', { count: DAYS_SHOWN })}</p>}
        </>
      )}
    </section>
  );
}
