import { useState } from 'react';
import { z } from 'zod';
import { Button, Field } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { ReadFailure, ReadLoading } from '../../../shared/read-state';
import { parseAmount } from '../../../shared/money';
import { useSession } from '../../session';
import { amount, bps, date, funds, positiveMoney, useBankRead, useBankRecord, usePageLimit, type ActionSpec } from '../components';
import { t as copyText } from '../copy';
import { availableRow, earnFormFacts, earnLiveRows } from '../form-preview';
import { useHoldings } from '../holdings';
import { bankReads, bankWrites, type earnPoolPageSchema, type poolSchema, type positionSchema } from '../contracts';
import { CALCULATOR_MAX_DAYS, earnCalculation } from '../earn-calculator';
import { earnCopy } from '../earn-copy';
import { utcDay } from '../earn-rate-history';
import { earnPoolActionsCopy } from '../earn-pool-actions-copy';
import {
  BANK_EARN_INTEREST_HISTORY,
  BANK_EARN_POOLS,
  BANK_EARN_POSITIONS,
  BANK_EARN_POOL,
  BANK_EARN_SET_AUTO_RENEW,
} from '@intafaced/contracts/bank-earn-procedures';
import { BANK_AUTO_INVEST_LIST } from '@intafaced/contracts/bank-auto-invest-procedures';
import { BANK_EARN_DEPOSIT, BANK_EARN_WITHDRAW } from '@intafaced/contracts/bank-earn-2-procedures';
import {
  BANK_AUTO_INVEST_CREATE_ROUND_UP,
  BANK_AUTO_INVEST_CREATE_THRESHOLD_SWEEP,
} from '@intafaced/contracts/bank-auto-invest-2-procedures';

type Pool = z.infer<typeof earnPoolPageSchema>;
type Position = z.infer<typeof positionSchema>;
type Open = (spec: ActionSpec) => void;
const POSITIONS = 50;
const DAYS_SHOWN = 31;
const RULES = 200;

const readFailed = (subject: string): ApiResult<null> => ({
  ok: false,
  reason: 'error',
  code: 'money.review_read_unavailable',
  message: earnCopy.t('readFailed', { subject }),
});
const changed = (): ApiResult<null> => ({ ok: false, reason: 'error', code: 'money.review_changed', message: earnCopy.t('changed') });

/**
 * The calculator (BK-earn-03, crypto-credit-earn-045, J-bank-08 #3): an amount and a number of days at the pool's
 * published rate, worked out the way the bank pays it (`earnCalculation`), with the formula stated.
 */
export function EarnCalculator({ pool }: { pool: Pool }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const [principal, setPrincipal] = useState('');
  const [days, setDays] = useState(String(pool.termDays ?? 30));
  const result = earnCalculation({ amount: principal, aprBps: pool.aprBps, days: Number(days) });
  const typed = principal.trim() !== '';
  return (
    <section data-testid="earn-calculator" aria-label={t('calculatorTitle')}>
      <h3>{t('calculatorTitle')}</h3>
      <p className="lt-hint">{t('calculatorLead')}</p>
      <div className="lt-actions">
        <Field
          label={t('calculatorAmount', { asset: pool.assetId })}
          name="calculatorAmount"
          inputMode="decimal"
          autoComplete="off"
          value={principal}
          onChange={(event) => setPrincipal(event.target.value)}
        />
        <Field
          label={t('calculatorDays')}
          name="calculatorDays"
          inputMode="numeric"
          autoComplete="off"
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
      </div>
      {result ? (
        <dl className="lt-kv" data-testid="earn-calculator-result" data-per-day={result.perDay} data-total={result.total}>
          <div>
            <dt>{t('calculatorPerDay')}</dt>
            <dd>{amount(result.perDay, pool.assetId)}</dd>
          </div>
          <div>
            <dt>{t('calculatorTotal', { days: result.days })}</dt>
            <dd>{amount(result.total, pool.assetId)}</dd>
          </div>
        </dl>
      ) : (
        typed && (
          <p className="lt-hint" role="status" data-testid="earn-calculator-invalid">
            {t('calculatorInvalid', { max: CALCULATOR_MAX_DAYS })}
          </p>
        )
      )}
      <p className="lt-hint" data-testid="earn-calculator-formula">
        {t('calculatorFormula', { rate: bps(pool.aprBps) })}
      </p>
      <p className="lt-hint">{t('calculatorIllustration')}</p>
    </section>
  );
}

/** Saving in this pool (BK-earn-01, J-bank-08 #3): the bank refuses an amount under the pool's minimum, and so does the form. */
export function PoolDeposit({ pool, open }: { pool: Pool; open: Open }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const { api } = useSession();
  const preflight = async (): Promise<ApiResult<null>> => {
    const fresh = await api.call(BANK_EARN_POOL, { poolId: pool.id });
    if (!fresh.ok) return readFailed(t('subjectPool'));
    return JSON.stringify(fresh.data) === JSON.stringify(pool) ? { ok: true, data: null } : changed();
  };
  const term = pool.termDays === null ? t('flexible') : t('termDays', { days: pool.termDays });
  if (pool.status !== 'open') {
    return (
      <p className="lt-hint" data-testid="earn-pool-deposit" data-state="closed">
        {t('closedToDeposits')}
      </p>
    );
  }
  return (
    <div className="lt-actions" data-testid="earn-pool-deposit" data-state="open">
      <Button
        tone="primary"
        onClick={() =>
          open({
            title: t('depositTitle'),
            record: BANK_EARN_DEPOSIT,
            unit: pool.assetId,
            fields: [positiveMoney(pool.assetId)],
            facts: [
              [t('pool'), pool.name],
              [t('rate'), bps(pool.aprBps)],
              [t('term'), term],
              [t('minimum'), amount(pool.minDeposit, pool.assetId)],
            ],
            notes: [t('depositNote', { asset: pool.assetId }), t('depositStarts')],
            preflight,
            validate: (input) =>
              parseAmount(String(input.amount)) >= parseAmount(pool.minDeposit)
                ? null
                : t('belowMinimum', { minimum: amount(pool.minDeposit, pool.assetId) }),
            verifyOutcome: (data) => {
              const returned = data as z.infer<(typeof BANK_EARN_DEPOSIT)['output']>;
              // The id is checked for every earn write (`bankWriteForReview`); a term is this review's own promise.
              return (pool.termDays === null) === (returned.maturesAt === null);
            },
            input: (values, requestId) => ({ poolId: pool.id, positionId: requestId, amount: values.amount }),
            submit: t('deposit'),
          })
        }
      >
        {t('deposit')}
      </Button>
    </div>
  );
}

/**
 * Where a saving stands: waiting for its first full UTC day, then accruing (in a closed pool too); a staking-style saving
 * asked back earns nothing while unbonding (BK-earn-04).
 */
export function AccrualState({ position }: { position: Position }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const line = () => {
    switch (position.accrual) {
      case 'waiting':
        return t('waiting', { date: utcDay(position.accruesFrom) });
      case 'accruing':
        return t('accruing');
      case 'unbonding':
        // The bank sends the date with every unbonding saving.
        return position.unbondsAt ? t('unbonding', { date: date(position.unbondsAt) }) : null;
      case 'below_unit':
        return t('belowUnit');
    }
  };
  return (
    <p className="lt-hint" data-testid="earn-pool-accrual" data-state={position.accrual} data-from={position.accruesFrom}>
      {line()}
    </p>
  );
}

/**
 * Taking a saving back (BK-earn-01, J-bank-08 #8). The page sends it once; a lost answer is left to the request's
 * reference and is never settled by a list that no longer shows the saving (the review's own unknown-outcome journal).
 * In a staking-style pool (BK-earn-04, J-bank-08 #6) the first ask starts unbonding instead: nothing moves until it ends,
 * then the bank's job pays it back, or the saver takes it back.
 */
export function PoolWithdraw({ pool, position, open }: { pool: Pool; position: Position; open: Open }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const { api } = useSession();
  const lockedUntil = position.maturesAt !== null && Date.parse(position.maturesAt) > Date.now() ? position.maturesAt : null;
  if (lockedUntil) {
    return (
      <p className="lt-hint" data-testid="earn-withdraw" data-state="locked">
        {t('locked', { date: date(lockedUntil) })}
      </p>
    );
  }
  const unbondsAt = position.unbondsAt;
  // The bank's clock says whether the unbonding has ended, so a device clock that runs fast or slow changes nothing.
  if (unbondsAt !== null && position.staking === 'unbonding') {
    return (
      <p className="lt-hint" data-testid="earn-withdraw" data-state="unbonding" data-until={unbondsAt}>
        {t('unbondingUntil', { date: date(unbondsAt) })}
      </p>
    );
  }
  const unbondingDays = unbondsAt === null ? position.unbondingDays : null;
  const preflight = async (): Promise<ApiResult<null>> => {
    const fresh = await api.call(BANK_EARN_POSITIONS, { limit: POSITIONS, poolId: pool.id });
    if (!fresh.ok) return readFailed(t('subjectPosition'));
    const current = fresh.data.find((row) => row.id === position.id);
    // Missing from this read proves nothing about an earlier send: it is a change, never an outcome.
    return current &&
      current.principal === position.principal &&
      current.maturesAt === position.maturesAt &&
      current.unbondsAt === position.unbondsAt
      ? { ok: true, data: null }
      : changed();
  };
  if (unbondingDays !== null) {
    // Shown as an estimate from today; the bank's answer carries the real date, and the saving then shows it.
    const estimate = new Date(Date.now() + unbondingDays * 24 * 60 * 60 * 1000).toISOString();
    return (
      <Button
        tone="secondary"
        data-testid="earn-withdraw"
        data-state="staked"
        onClick={() =>
          open({
            title: t('unbondTitle', { amount: amount(position.principal, position.assetId) }),
            record: BANK_EARN_WITHDRAW,
            unit: position.assetId,
            facts: [
              [t('pool'), pool.name],
              [t('saved'), amount(position.principal, position.assetId)],
            ],
            notes: [
              t('unbondNote', { days: unbondingDays, date: date(estimate) }),
              t('unbondEarns'),
              t('unbondFinal'),
              t('withdrawOutcome'),
            ],
            preflight,
            verifyOutcome: (data) => {
              const returned = data as z.infer<(typeof BANK_EARN_WITHDRAW)['output']>;
              return returned.status === 'unbonding' && parseAmount(returned.principal) === parseAmount(position.principal);
            },
            // Only an ask that says so starts the wait; the bank refuses a plain take back of a staking-style saving.
            input: () => ({ positionId: position.id, unbond: true }),
            submit: t('unbond'),
          })
        }
      >
        {t('unbond')}
      </Button>
    );
  }
  const takeBack = () =>
    open({
      title: t('withdrawTitle', { amount: amount(position.principal, position.assetId) }),
      record: BANK_EARN_WITHDRAW,
      unit: position.assetId,
      facts: [
        [t('pool'), pool.name],
        [t('saved'), amount(position.principal, position.assetId)],
      ],
      notes: [t('withdrawNote'), t('withdrawOutcome')],
      preflight,
      verifyOutcome: (data) => {
        const returned = data as z.infer<(typeof BANK_EARN_WITHDRAW)['output']>;
        return returned.status === 'closed' && parseAmount(returned.principal) === parseAmount(position.principal);
      },
      input: () => ({ positionId: position.id }),
      submit: t('withdraw'),
    });
  if (unbondsAt !== null) {
    return (
      <div data-testid="earn-withdraw" data-state="unbonded" data-until={unbondsAt}>
        <p className="lt-hint">{t('unbondEnded', { date: date(unbondsAt) })}</p>
        <Button tone="secondary" onClick={takeBack}>
          {t('withdraw')}
        </Button>
      </div>
    );
  }
  return (
    <Button tone="secondary" data-testid="earn-withdraw" data-state="open" onClick={takeBack}>
      {t('withdraw')}
    </Button>
  );
}

/**
 * A fixed-term saving's term and its auto-renew choice (BK-earn-03, crypto-credit-earn-056/057, J-bank-08 #4): the lock
 * date, how many terms auto-renew has started, and the choice itself. On, a new term of the pool's length starts with
 * the same amount when this one ends; a term that is over, or a pool that takes no new terms, offers only what is true.
 */
export function FixedTerm({ pool, position, open }: { pool: Pool; position: Position; open: Open }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const { api } = useSession();
  if (position.maturesAt === null) return null;
  const maturesAt = position.maturesAt;
  const ended = Date.parse(maturesAt) <= Date.now();
  const days = pool.termDays ?? 0;
  const preflight = async (): Promise<ApiResult<null>> => {
    const fresh = await api.call(BANK_EARN_POSITIONS, { limit: POSITIONS, poolId: pool.id });
    if (!fresh.ok) return readFailed(t('subjectRenew'));
    const current = fresh.data.find((row) => row.id === position.id);
    return current && current.maturesAt === maturesAt && current.autoRenew === position.autoRenew ? { ok: true, data: null } : changed();
  };
  const choose = (on: boolean) =>
    open({
      title: t(on ? 'renewOnTitle' : 'renewOffTitle'),
      record: BANK_EARN_SET_AUTO_RENEW,
      unit: position.assetId,
      facts: [
        [t('pool'), pool.name],
        [t('saved'), amount(position.principal, position.assetId)],
        [t('term'), t('termDays', { days })],
        [t('renewEnds'), date(maturesAt)],
      ],
      notes: on ? [t('renewOnNote'), t('renewOnTakeBack')] : [t('renewOffNote')],
      preflight,
      input: () => ({ positionId: position.id, on }),
      submit: t(on ? 'renewTurnOn' : 'renewTurnOff'),
    });
  // Only an open pool takes a new term, and only a term still running can be renewed (the bank refuses the rest).
  const poolOpen = pool.status === 'open';
  const canTurnOn = !ended && poolOpen;
  // What the bank will do at the end of the term, and nothing it will not.
  const renewLine = () => {
    if (position.autoRenew && !poolOpen) return t('renewOnClosed', { date: date(maturesAt) });
    if (position.autoRenew) return ended ? t('renewDue', { days }) : t('renewOn', { date: date(maturesAt), days });
    if (!poolOpen) return t('renewClosed');
    return ended ? t('renewOffEnded') : t('renewOff', { date: date(maturesAt) });
  };
  return (
    <div data-testid="earn-fixed-term" data-matures={maturesAt} data-renewals={position.renewals}>
      <p className="lt-hint">{ended ? t('fixedEnded', { date: date(maturesAt) }) : t('fixedTerm', { days, date: date(maturesAt) })}</p>
      {position.renewals > 0 && <p className="lt-hint">{t('renewedCount', { count: position.renewals })}</p>}
      <div data-testid="earn-auto-renew" data-on={String(position.autoRenew)}>
        <p className="lt-hint">{renewLine()}</p>
        {position.autoRenew ? (
          <Button tone="quiet" onClick={() => choose(false)}>
            {t('renewTurnOff')}
          </Button>
        ) : (
          canTurnOn && (
            <Button tone="secondary" onClick={() => choose(true)}>
              {t('renewTurnOn')}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/**
 * When the bank pays this saving (BK-earn-03, crypto-credit-earn-044, J-bank-08 #5): once a UTC day, to the main
 * balance, so nothing compounds; the next day the bank has not yet paid this pool, from `earn.positions`.
 */
export function PayoutSchedule({ pool, position }: { pool: Pool; position: Position }) {
  const { t } = earnPoolActionsCopy.useCopy();
  return (
    <div data-testid="earn-payout-schedule" data-next={position.nextPayoutOn ?? ''}>
      <h4>{t('scheduleTitle')}</h4>
      <p className="lt-hint">{t('scheduleDaily', { asset: position.assetId })}</p>
      {pool.termDays !== null && <p className="lt-hint">{t('scheduleThroughTerm')}</p>}
      <p className="lt-hint" data-testid="earn-payout-next">
        <strong>{position.nextPayoutOn ? t('scheduleNext', { date: utcDay(position.nextPayoutOn) }) : t('scheduleNone')}</strong>
      </p>
      <p className="lt-hint" data-testid="earn-compounding" data-compounding="none">
        {t('compounding')}
      </p>
    </div>
  );
}

/** The interest this pool has paid the person, day by day, from the bank's own record (`earn.interestHistory`). */
export function PoolEarned({ pool }: { pool: Pool }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const history = useBankRecord(BANK_EARN_INTEREST_HISTORY, { poolId: pool.id, limit: DAYS_SHOWN });
  if (history.resource.status === 'loading') return <ReadLoading />;
  if (history.resource.status === 'failed') return <ReadFailure result={history.resource.failure} retry={history.reload} />;
  const earned = history.resource.data;
  return (
    <section data-testid="earn-pool-earned" data-total={earned.total} aria-label={t('earnedTitle')}>
      <h4>{t('earnedTitle')}</h4>
      {earned.days.length ? (
        <>
          <p className="lt-hint">
            {t('earnedTotal')}: <span>{funds(earned.total, pool.assetId)}</span>
          </p>
          <EarnedDays pool={pool} days={earned.days} />
        </>
      ) : (
        earned.unitemisedDays === 0 && <p className="lt-hint">{t('earnedNone')}</p>
      )}
      {earned.unitemisedDays > 0 && (
        <p className="lt-hint" data-testid="earn-pool-earned-unitemised">
          {t('earnedUnitemised', { count: earned.unitemisedDays })}
        </p>
      )}
    </section>
  );
}

type PaidDay = { date: string; rateBps: number; amount: string };

/** One page of paid days; a full page offers the page before it, so every day in the total can be reached. */
function EarnedDays({ pool, days }: { pool: Pool; days: PaidDay[] }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const [earlier, setEarlier] = useState(false);
  return (
    <>
      <ul>
        {days.map((day) => (
          <li key={day.date} data-testid="earn-pool-earned-day" data-date={day.date} data-amount={day.amount} data-bps={day.rateBps}>
            {t('earnedDay', { date: utcDay(day.date), amount: funds(day.amount, pool.assetId), rate: bps(day.rateBps) })}
          </li>
        ))}
      </ul>
      {days.length >= DAYS_SHOWN &&
        (earlier ? (
          <EarlierDays pool={pool} before={days[days.length - 1]!.date} />
        ) : (
          <>
            <p className="lt-hint">{t('earnedLatest', { count: days.length })}</p>
            <Button tone="quiet" onClick={() => setEarlier(true)}>
              {t('earnedEarlier')}
            </Button>
          </>
        ))}
    </>
  );
}

function EarlierDays({ pool, before }: { pool: Pool; before: string }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const page = useBankRecord(BANK_EARN_INTEREST_HISTORY, { poolId: pool.id, limit: DAYS_SHOWN, before });
  if (page.resource.status === 'loading') return <ReadLoading />;
  if (page.resource.status === 'failed') return <ReadFailure result={page.resource.failure} retry={page.reload} />;
  return page.resource.data.days.length ? (
    <EarnedDays pool={pool} days={page.resource.data.days} />
  ) : (
    <p className="lt-hint">{t('earnedNoEarlier')}</p>
  );
}

/**
 * Auto earn into this pool (BK-earn-01, crypto-credit-earn-049, J-bank-08 #7): a same-asset threshold sweep, saved by
 * the bank. The keep-amount must be above zero (the form and `bank.auto_invest_invalid_threshold`). A bank with auto
 * earn switched off says so and offers nothing to save.
 */
export function AutoEarn({ pool, open }: { pool: Pool; open: Open }) {
  const { t } = earnPoolActionsCopy.useCopy();
  const { api } = useSession();
  const policy = useBankRead('autoInvest.policy', undefined);
  const rules = useBankRecord(BANK_AUTO_INVEST_LIST, { limit: RULES });
  const preflight = async (): Promise<ApiResult<null>> => {
    const [freshPool, freshPolicy] = await Promise.all([
      api.call(BANK_EARN_POOL, { poolId: pool.id }),
      api.query('bank', 'autoInvest.policy', undefined, bankReads['autoInvest.policy']),
    ]);
    if (!freshPool.ok) return readFailed(t('subjectPool'));
    if (!freshPolicy.ok) return readFailed(t('subjectPolicy'));
    return JSON.stringify(freshPool.data) === JSON.stringify(pool) && freshPolicy.data.enabled ? { ok: true, data: null } : changed();
  };
  const mine =
    rules.resource.status === 'ready'
      ? rules.resource.data.filter(
          (rule) => rule.kind === 'threshold_sweep' && rule.targetPoolId === pool.id && rule.status !== 'cancelled',
        )
      : [];
  const body = () => {
    if (policy.resource.status === 'loading') return <ReadLoading />;
    if (policy.resource.status === 'failed') return <ReadFailure result={policy.resource.failure} retry={policy.reload} />;
    if (!policy.resource.data.enabled) {
      return (
        <p className="lt-hint" data-state="off">
          {t('autoOff')}
        </p>
      );
    }
    return (
      <>
        {rules.resource.status === 'failed' && <ReadFailure result={rules.resource.failure} retry={rules.reload} />}
        {mine.map((rule) => (
          <p key={rule.id} className="lt-hint" data-testid="earn-auto-earn-rule" data-rule={rule.id} data-status={rule.status}>
            {t(rule.status === 'active' ? 'autoSaved' : 'autoPaused', { threshold: amount(rule.threshold, rule.assetId) })}{' '}
            <a className="lt-link" href="/bank/earn">
              {t('autoManage')}
            </a>
          </p>
        ))}
        {/* One rule per pool here: a saved one is paused or stopped on the Earn page, where every rule is listed. */}
        {pool.status === 'open' && rules.resource.status === 'ready' && mine.length === 0 && (
          <div className="lt-actions">
            <Button
              tone="secondary"
              onClick={() =>
                open({
                  title: t('autoTitleDialog'),
                  record: BANK_AUTO_INVEST_CREATE_THRESHOLD_SWEEP,
                  unit: pool.assetId,
                  fields: [{ ...positiveMoney(pool.assetId, 'threshold', t('autoKeep')), hint: t('autoKeepHint') }],
                  facts: [
                    [t('pool'), pool.name],
                    [t('minimum'), amount(pool.minDeposit, pool.assetId)],
                  ],
                  notes: [t('autoLead', { asset: pool.assetId }), t('autoNote')],
                  preflight,
                  input: (values) => ({ assetId: pool.assetId, targetPoolId: pool.id, threshold: values.threshold }),
                  submit: t('autoTurnOn'),
                })
              }
            >
              {t('autoTurnOn')}
            </Button>
          </div>
        )}
      </>
    );
  };
  return (
    <section data-testid="earn-auto-earn" aria-label={t('autoTitle')}>
      <p className="lt-hint">{t('autoLead', { asset: pool.assetId })}</p>
      {body()}
    </section>
  );
}

/**
 * What the Earn room (`/bank/earn`, EarnRooms.tsx) reads and the reviews it opens: the pools and the person's savings, the
 * automation policy, the checks a review runs again before it is sent, and each review's terms as the bank states them.
 */
export function useEarnRoom() {
  const { api } = useSession();
  const [limit, setLimit] = usePageLimit();
  const fail = (subject: string): ApiResult<null> => ({
    ok: false,
    reason: 'error',
    code: 'money.review_read_unavailable',
    message: earnCopy.t('readFailed', { subject }),
  });
  const changed = (): ApiResult<null> => ({ ok: false, reason: 'error', code: 'money.review_changed', message: earnCopy.t('changed') });
  const validMaturity = (at: string) => z.string().datetime({ offset: true }).safeParse(at).success;
  const maturityAllowsReview = (at: string | null) => at === null || (validMaturity(at) && Date.parse(at) <= Date.now());
  async function checkPool(pool: z.infer<typeof poolSchema>, automation = false): Promise<ApiResult<null>> {
    const fresh = await api.call(BANK_EARN_POOLS, { limit });
    if (!fresh.ok) return fail(earnCopy.t('subjectPool'));
    const current = fresh.data.find((row) => row.id === pool.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(pool)) return changed();
    if (automation) {
      const policy = await api.query('bank', 'autoInvest.policy', undefined, bankReads['autoInvest.policy']);
      if (!policy.ok) return fail(earnCopy.t('subjectPolicy'));
      if (!policy.data.enabled) return changed();
    }
    return { ok: true, data: null };
  }
  async function checkPosition(position: z.infer<typeof positionSchema>): Promise<ApiResult<null>> {
    const fresh = await api.call(BANK_EARN_POSITIONS, { limit });
    if (!fresh.ok) return fail(earnCopy.t('subjectPosition'));
    const current = fresh.data.find((row) => row.id === position.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(position) || !maturityAllowsReview(current.maturesAt)) return changed();
    return { ok: true, data: null };
  }
  const pools = useBankRecord(BANK_EARN_POOLS, { limit });
  const positions = useBankRecord(BANK_EARN_POSITIONS, { limit });
  const held = useHoldings();
  const heldRows = held.resource.status === 'ready' ? held.resource.data.holdings : null;
  const automation = useBankRead('autoInvest.policy', undefined);
  return {
    limit,
    setLimit,
    pools,
    positions,
    automation,
    validMaturity,
    maturityAllowsReview,
    review: {
      withdraw: (position: z.infer<typeof positionSchema>): ActionSpec => ({
        title: copyText('rooms.withdraw.earn.principal'),
        unit: position.assetId,
        record: BANK_EARN_WITHDRAW,

        preflight: () => checkPosition(position),
        verifyOutcome: (data) => {
          const returned = data as z.infer<(typeof BANK_EARN_WITHDRAW)['output']>;
          return (
            returned.positionId === position.id &&
            returned.status === 'closed' &&
            parseAmount(returned.principal) === parseAmount(position.principal)
          );
        },
        facts: [
          [copyText('rooms.position'), position.id],
          [copyText('rooms.principal.2'), amount(position.principal, position.assetId)],
          [copyText('rooms.matures.2'), date(position.maturesAt)],
        ],
        notes: [copyText('rooms.the.service.checks.maturity.and.reconciles.ledger'), earnCopy.t('withdrawalOutcome')],
        input: () => ({ positionId: position.id }),
      }),
      deposit: (pool: z.infer<typeof poolSchema>): ActionSpec => ({
        title: copyText('rooms.deposit.into.earn'),
        record: BANK_EARN_DEPOSIT,

        preflight: () => checkPool(pool),
        verifyOutcome: (data, input) => {
          const returned = data as z.infer<(typeof BANK_EARN_DEPOSIT)['output']>;
          const fixed = pool.kind === 'fixed' && pool.termDays !== null;
          return (
            returned.positionId === input.positionId &&
            (fixed ? z.string().datetime({ offset: true }).safeParse(returned.maturesAt).success : returned.maturesAt === null)
          );
        },
        fields: [positiveMoney(pool.assetId)],
        formFacts: earnFormFacts(pool, availableRow(pool.assetId, heldRows, funds), new Date(), bps),
        liveRows: (values) => earnLiveRows(pool, values, funds),
        facts: [
          [copyText('rooms.pool'), pool.name],
          [copyText('rooms.apr.2'), bps(pool.aprBps)],
          [
            copyText('rooms.term'),
            pool.termDays === null ? copyText('rooms.flexible.term') : copyText('rooms.days', { value1: pool.termDays }),
          ],
          [copyText('rooms.minimum'), amount(pool.minDeposit, pool.assetId)],
        ],
        notes: [
          copyText('rooms.principal.moves.from.your.user.available.account'),
          copyText('rooms.the.service.verifies.the.pool.is.open'),
        ],
        validate: (input) =>
          parseAmount(String(input.amount)) >= parseAmount(pool.minDeposit)
            ? null
            : copyText('rooms.the.amount.is.below.the.configured.minimum'),
        input: (values, requestId) => ({ poolId: pool.id, positionId: requestId, amount: values.amount }),
      }),
      sweep: (pool: z.infer<typeof poolSchema>): ActionSpec => ({
        title: copyText('rooms.create.threshold.sweep'),
        record: BANK_AUTO_INVEST_CREATE_THRESHOLD_SWEEP,
        unit: pool.assetId,
        preflight: () => checkPool(pool, true),
        fields: [
          {
            ...positiveMoney(pool.assetId, 'threshold', earnCopy.t('keepAvailable')),
            hint: earnCopy.t('thresholdHint'),
          },
        ],
        facts: [
          [copyText('rooms.pool'), pool.name],
          [copyText('rooms.asset'), pool.assetId],
        ],
        notes: [copyText('rooms.keep.this.exact.quantity.in.the.primary'), copyText('rooms.no.cross.asset.rate.is.assumed.the')],
        input: (values) => ({ assetId: pool.assetId, targetPoolId: pool.id, threshold: values.threshold }),
      }),
      roundUp: (pool: z.infer<typeof poolSchema>): ActionSpec => ({
        title: copyText('rooms.create.card.round.up'),
        record: BANK_AUTO_INVEST_CREATE_ROUND_UP,
        unit: pool.assetId,
        preflight: () => checkPool(pool, true),
        fields: [positiveMoney(pool.assetId, 'granularity', copyText('rooms.round.up.increment'))],
        facts: [
          [copyText('rooms.pool'), pool.name],
          [copyText('rooms.asset'), pool.assetId],
        ],
        notes: [copyText('rooms.same.asset.spare.change.goes.to.this'), copyText('rooms.this.instruction.does.not.connect.an.issuer')],
        input: (values) => ({ assetId: pool.assetId, targetPoolId: pool.id, granularity: values.granularity }),
      }),
    },
  };
}
