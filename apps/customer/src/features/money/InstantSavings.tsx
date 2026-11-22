import { useState } from 'react';
import type { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { Button, Failure, Loading } from '../../shared/ui';
import { parseAmount } from '../../shared/money';
import { amount, bps, funds, NoRows, positiveMoney, Section, type ActionSpec, useBankRecord } from './components';
import { bankWrites, type poolSchema, type positionSchema } from './contracts';
import { earnCopy } from './earn-copy';
import { useSession } from '../session';
import { instantSavingsCopy } from './instant-savings-copy';
import { BANK_EARN_POOLS, BANK_EARN_POSITIONS, BANK_EARN_INTEREST_HISTORY } from '@intafaced/contracts/bank-earn-procedures';
import { BANK_EARN_DEPOSIT, BANK_EARN_WITHDRAW } from '@intafaced/contracts/bank-earn-2-procedures';

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
  const { api } = useSession();
  const pools = useBankRecord(BANK_EARN_POOLS, { limit: LIMIT });
  const positions = useBankRecord(BANK_EARN_POSITIONS, { limit: LIMIT });
  /** Inside the write lock, before anything is sent: the pool still reads as it did when the review opened. */
  const checkPool = async (pool: Pool): Promise<ApiResult<null>> => {
    const fresh = await api.call(BANK_EARN_POOLS, { limit: LIMIT });
    if (!fresh.ok) return readFailed(earnCopy.t('subjectPool'));
    const current = fresh.data.find((row) => row.id === pool.id);
    return current && JSON.stringify(current) === JSON.stringify(pool) ? { ok: true, data: null } : changed();
  };

  const openSavings = (pool: Pool) =>
    open({
      title: t('openTitle', { asset: pool.assetId }),
      record: BANK_EARN_DEPOSIT,
      unit: pool.assetId,
      fields: [positiveMoney(pool.assetId)],
      facts: [
        [t('pool'), pool.name],
        [t('annualRate'), bps(pool.aprBps)],
        [t('smallest'), amount(pool.minDeposit, pool.assetId)],
      ],
      notes: [t('openNote'), t('openAnytime')],
      preflight: () => checkPool(pool),
      validate: (input) => (parseAmount(String(input.amount)) >= parseAmount(pool.minDeposit) ? null : t('belowMinimum')),
      verifyOutcome: (data, input) => {
        const returned = data as z.infer<(typeof BANK_EARN_DEPOSIT)['output']>;
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
    // Instant access only: a staking-style pool waits through unbonding, so it lives on its own pool page (BK-earn-04).
    const flexible = pools.resource.data.filter((pool) => pool.kind === 'flexible' && pool.unbondingDays === null);
    if (!flexible.length) return <NoRows title={t('noPools')} />;
    const held = positions.resource.status === 'ready' ? positions.resource.data : null;
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
            {held && <Savings pool={pool} positions={held.filter((position) => position.poolId === pool.id)} open={open} />}
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

const readFailed = (subject: string): ApiResult<null> => ({
  ok: false,
  reason: 'error',
  code: 'money.review_read_unavailable',
  message: earnCopy.t('readFailed', { subject }),
});
const changed = (): ApiResult<null> => ({ ok: false, reason: 'error', code: 'money.review_changed', message: earnCopy.t('changed') });

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

/**
 * The person's savings in one pool: what is saved, the interest the bank has paid on it and each paid day. Interest
 * already paid stays listed after the savings go back to the account; a pool the person never saved in shows nothing.
 */
function Savings({ pool, positions, open }: { pool: Pool; positions: Position[]; open: (spec: ActionSpec) => void }) {
  const { t } = instantSavingsCopy.useCopy();
  const { api } = useSession();
  const history = useBankRecord(BANK_EARN_INTEREST_HISTORY, { poolId: pool.id, limit: DAYS_SHOWN });
  const checkPosition = async (position: Position): Promise<ApiResult<null>> => {
    const fresh = await api.call(BANK_EARN_POSITIONS, { limit: LIMIT });
    if (!fresh.ok) return readFailed(earnCopy.t('subjectPosition'));
    const current = fresh.data.find((row) => row.id === position.id);
    return current && JSON.stringify(current) === JSON.stringify(position) ? { ok: true, data: null } : changed();
  };
  const withdraw = (position: Position) =>
    open({
      title: t('withdrawTitle', { amount: amount(position.principal, position.assetId) }),
      record: BANK_EARN_WITHDRAW,
      unit: position.assetId,
      facts: [
        [t('pool'), pool.name],
        [t('saved'), amount(position.principal, position.assetId)],
      ],
      notes: [t('withdrawNote')],
      preflight: () => checkPosition(position),
      verifyOutcome: (data) => {
        const returned = data as z.infer<(typeof BANK_EARN_WITHDRAW)['output']>;
        return (
          returned.positionId === position.id &&
          returned.status === 'closed' &&
          parseAmount(returned.principal) === parseAmount(position.principal)
        );
      },
      input: () => ({ positionId: position.id }),
      submit: t('withdraw'),
    });
  const earned = history.resource.status === 'ready' ? history.resource.data : null;
  if (!positions.length && earned && !earned.days.length) return null;
  return (
    <section data-testid="instant-savings-mine" aria-label={t('yours', { asset: pool.assetId })}>
      <h4>{t('yours', { asset: pool.assetId })}</h4>
      {positions.length ? (
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
      ) : (
        <p className="money-caption">{t('nothingSaved')}</p>
      )}
      {history.resource.status === 'loading' && <Loading />}
      {history.resource.status === 'failed' && <Failure result={history.resource.failure} retry={history.reload} />}
      {earned && (
        <>
          <dl className="money-selected-details">
            <div>
              <dt>{t('earned')}</dt>
              <dd className="numeric" data-testid="instant-savings-earned" data-amount={earned.total}>
                {funds(earned.total, pool.assetId)}
              </dd>
              <dd className="money-caption">{t('earnedNote')}</dd>
              {earned.unitemisedDays > 0 && (
                <dd className="money-caption" data-testid="instant-savings-unitemised">
                  {t('unitemised', { count: earned.unitemisedDays })}
                </dd>
              )}
            </div>
          </dl>
          <h4>{t('days')}</h4>
          {earned.days.length ? <Days pool={pool} days={earned.days} /> : <p className="money-caption">{t('noDays')}</p>}
        </>
      )}
    </section>
  );
}

type Day = { date: string; rateBps: number; amount: string };

/** One page of paid days, and the door to the page before it once this one is full. */
function Days({ pool, days }: { pool: Pool; days: Day[] }) {
  const { t } = instantSavingsCopy.useCopy();
  const [earlier, setEarlier] = useState(false);
  const oldest = days[days.length - 1]!.date;
  return (
    <>
      <ul className="money-list">
        {days.map((day) => (
          <li key={day.date} data-testid="instant-savings-day" data-date={day.date} data-amount={day.amount} data-bps={day.rateBps}>
            {t('day', { date: calendarDay(day.date), amount: funds(day.amount, pool.assetId), rate: bps(day.rateBps) })}
          </li>
        ))}
      </ul>
      {days.length >= DAYS_SHOWN &&
        (earlier ? (
          <EarlierDays pool={pool} before={oldest} />
        ) : (
          <Button variant="ghost" onClick={() => setEarlier(true)}>
            {t('earlier')}
          </Button>
        ))}
    </>
  );
}

function EarlierDays({ pool, before }: { pool: Pool; before: string }) {
  const { t } = instantSavingsCopy.useCopy();
  const page = useBankRecord(BANK_EARN_INTEREST_HISTORY, { poolId: pool.id, limit: DAYS_SHOWN, before });
  if (page.resource.status === 'loading') return <Loading />;
  if (page.resource.status === 'failed') return <Failure result={page.resource.failure} retry={page.reload} />;
  return page.resource.data.days.length ? (
    <Days pool={pool} days={page.resource.data.days} />
  ) : (
    <p className="money-caption">{t('noEarlier')}</p>
  );
}
