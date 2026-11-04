import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button, Field, Input, SegmentedControl } from '@intafaced/ui';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { Refusal, RoomState } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { poolMasterCopy } from './pool-master-copy';

/**
 * The master center (CB-copy-pro-share-11, CB-copy-pro-share-04 creation), on the flow template. The person applies to
 * run a pooled strategy with a nickname, a contact and a trading style; the application waits in the founders' review
 * queue and its decision shows here. An approved master creates one strategy of a type whose limits the platform sets
 * (svc-trade refuses a type it has not set). A strategy has no investors and moves no money until pooled funds can be
 * held on the ledger, and the room says so.
 */

// hand-declared-ok: svc-trade's copy procedures have no browser-safe schema in packages/contracts yet (the Copy room's api.ts declares its own the same way)
const poolSchema = z.object({
  poolId: z.string(),
  name: z.string(),
  strategyType: z.enum(['stable', 'aggressive']),
  limits: z.object({ maxLeverage: z.string(), maxDrawdownPct: z.string(), maxCapital: z.string() }),
  state: z.string(),
  createdAt: z.string(),
});
const mineSchema = z.object({
  application: z
    .object({
      applicationId: z.string(),
      state: z.enum(['submitted', 'under_review', 'approved', 'disapproved']),
      nickname: z.string(),
      contact: z.string(),
      style: z.string(),
      submittedAt: z.string(),
      reason: z.string().nullable(),
      reapplyAfter: z.string().nullable().default(null),
    })
    .nullable(),
  pool: poolSchema.nullable(),
  investors: z.number().int(),
});
type Mine = z.infer<typeof mineSchema>;
type StrategyType = 'stable' | 'aggressive';

type T = ReturnType<typeof poolMasterCopy.useCopy>['t'];
type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** svc-trade's code: the code that ends the message in square brackets, or the error cause. */
function codeOf(failure: Failed): string | undefined {
  return /\[([a-z_.]+)\]\s*$/.exec(failure.message ?? '')?.[1] ?? failure.code;
}

/** svc-trade's refusals this room words itself: [title, body]. */
const REFUSALS: Record<string, (t: T) => [string, string]> = {
  'trade.pool_master_application_invalid': (t) => [t('invalidTitle'), t('invalidBody')],
  'trade.pool_master_application_open': (t) => [t('openTitle'), t('openBody')],
  'trade.pool_master_already_approved': (t) => [t('alreadyTitle'), t('alreadyBody')],
  'trade.copy_lead_reapply_wait_unset': (t) => [t('waitTitle'), t('waitBody')],
  'trade.copy_lead_reapply_wait': (t) => [t('waitRunningTitle'), t('waitRunningBody')],
  'trade.pool_master_not_approved': (t) => [t('notApprovedTitle'), t('notApprovedBody')],
  'trade.pool_limit_not_set': (t) => [t('limitUnsetTitle'), t('limitUnsetBody')],
  'trade.pool_one_strategy_only': (t) => [t('oneOnlyTitle'), t('oneOnlyBody')],
  'trade.pool_name_invalid': (t) => [t('nameTitle'), t('nameBody')],
};

/** A refused send, in the room's own words: the service's sentence is never shown. */
function refusalOf(failure: Failed, t: T): Refusal {
  const code = codeOf(failure);
  const reference = code ?? failure.reason;
  const known = code ? REFUSALS[code] : undefined;
  if (known) {
    const [title, body] = known(t);
    return { variant: 'refused', title, body, reference };
  }
  return {
    variant: failure.reason === 'unreachable' || failure.reason === 'uncertain' ? 'unreachable' : 'refused',
    title: t('refusedTitle'),
    body: failure.reason === 'uncertain' ? t('uncertainBody') : t('otherBody'),
    reference,
  };
}

/** A business key for one create: the same press retried is one strategy. */
const newKey = () => `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function PoolMasterRoom() {
  const { t } = poolMasterCopy.useCopy();
  const { api, userId } = useSession();
  const mine = useResource(
    (signal) =>
      userId ? api.query('trade', 'copy.pool.mine', undefined, mineSchema, { signal }) : Promise.resolve({ ok: true as const, data: null }),
    `pool-master:${userId ?? 'out'}`,
  );
  const [nickname, setNickname] = useState('');
  const [contact, setContact] = useState('');
  const [style, setStyle] = useState('');
  const [poolName, setPoolName] = useState('');
  const [strategyType, setStrategyType] = useState<StrategyType>('stable');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const createKey = useRef(newKey());
  const [sent, setSent] = useState<Mine | null>(null);
  const [justApplied, setJustApplied] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const ids = { nickname: useId(), contact: useId(), style: useId(), name: useId() };

  const current = sent ?? (mine.resource.status === 'ready' ? mine.resource.data : null);
  const application = current?.application ?? null;
  const pool = current?.pool ?? null;

  // After a rejection, applying again opens once the platform's wait has passed (svc-trade decides on its own clock).
  const reapplyAfter = application?.state === 'disapproved' ? application.reapplyAfter : null;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!reapplyAfter) return;
    const left = Date.parse(reapplyAfter) - clock;
    if (left <= 0) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(left + 250, 2_000_000_000));
    return () => clearTimeout(timer);
  }, [reapplyAfter, clock]);
  const waitOver = reapplyAfter !== null && Date.parse(reapplyAfter) <= clock;
  const canApply = userId !== null && current !== null && (!application || waitOver);
  const canCreate = application?.state === 'approved' && !pool;

  async function send(run: () => Promise<ApiResult<Mine>>, after?: (out: Mine) => void) {
    // One request per press, and never a second while the first has no answer.
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setRefusal(null);
    const out = await run();
    sending.current = false;
    setBusy(false);
    if (out.ok) {
      setSent(out.data);
      after?.(out.data);
    } else setRefusal(refusalOf(out, t));
  }

  function apply(e: FormEvent) {
    e.preventDefault();
    void send(
      () =>
        api.mutate(
          'trade',
          'copy.pool.applyAsMaster',
          { nickname: nickname.trim(), contact: contact.trim(), style: style.trim() },
          mineSchema,
        ),
      () => setJustApplied(true),
    );
  }

  function create(e: FormEvent) {
    e.preventDefault();
    void send(async () => {
      const made = await api.mutate(
        'trade',
        'copy.pool.create',
        { name: poolName.trim(), strategyType, clientRequestId: createKey.current },
        poolSchema,
      );
      if (!made.ok) return made;
      createKey.current = newKey();
      return { ok: true as const, data: { application, pool: made.data, investors: current?.investors ?? 0 } };
    });
  }

  const state: RoomState = useMemo(() => {
    if (!userId)
      return {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: t('signedOutTitle'),
          body: t('signedOutBody'),
          action: { label: t('signIn'), href: '/login?redirect=%2Fcopy%2Fpools%2Fmaster' },
        },
      };
    if (mine.resource.status === 'loading') return { kind: 'loading' };
    if (mine.resource.status === 'failed')
      return {
        kind: 'refused',
        refusal: {
          variant: 'unreachable',
          title: t('readFailedTitle'),
          body: t('readFailedBody'),
          reference: codeOf(mine.resource.failure) ?? mine.resource.failure.reason,
          action: { label: t('tryAgain'), href: '/copy/pools/master' },
        },
      };
    if (refusal) return { kind: 'ready', partial: { missing: refusal } };
    if (application?.state === 'disapproved' && application.reapplyAfter === null)
      return {
        kind: 'ready',
        partial: {
          missing: { variant: 'refused', title: t('waitTitle'), body: t('waitBody'), reference: 'trade.copy_lead_reapply_wait_unset' },
        },
      };
    return { kind: 'ready' };
  }, [userId, mine.resource, refusal, application?.state, application?.reapplyAfter, t]);

  const typeItems = [
    { value: 'stable', label: t('stable') },
    { value: 'aggressive', label: t('aggressive') },
  ];

  return (
    <FlowTemplate
      title={t('title')}
      description={t('description')}
      state={state}
      step={
        <div className="pool-master">
          {justApplied && application?.state === 'submitted' ? <p role="status">{t('applied', { name: application.nickname })}</p> : null}
          {!justApplied && application?.state === 'submitted' ? <p>{t('applied', { name: application.nickname })}</p> : null}
          {application?.state === 'under_review' ? <p>{t('underReview', { name: application.nickname })}</p> : null}
          {application?.state === 'approved' ? <p>{t('approved', { name: application.nickname })}</p> : null}
          {application?.state === 'disapproved' ? (
            <p>{t('rejected', { name: application.nickname, reason: application.reason ?? '' })}</p>
          ) : null}
          {reapplyAfter ? (
            <p>
              {waitOver ? t('reapplyOpen') : t('reapplyAfter')}{' '}
              <time dateTime={reapplyAfter} data-testid="reapply-after">
                {new Date(reapplyAfter).toLocaleString()}
              </time>
            </p>
          ) : null}
          {canApply ? (
            <form aria-label={t('apply')} onSubmit={apply}>
              <Field label={t('nicknameLabel')} hint={t('nicknameHint')}>
                <Input id={ids.nickname} value={nickname} onValueChange={setNickname} maxLength={80} autoComplete="nickname" />
              </Field>
              <Field label={t('contactLabel')} hint={t('contactHint')}>
                <Input id={ids.contact} value={contact} onValueChange={setContact} maxLength={200} />
              </Field>
              <Field label={t('styleLabel')} hint={t('styleHint')}>
                <Input id={ids.style} value={style} onValueChange={setStyle} maxLength={500} />
              </Field>
              <Button type="submit" variant="primary" loading={busy} disabled={busy}>
                {t('apply')}
              </Button>
            </form>
          ) : null}
          {canCreate ? (
            <form aria-label={t('createTitle')} onSubmit={create}>
              <h2>{t('createTitle')}</h2>
              <Field label={t('nameLabel')} hint={t('nameHint')}>
                <Input id={ids.name} value={poolName} onValueChange={setPoolName} maxLength={80} />
              </Field>
              <SegmentedControl
                aria-label={t('typeLabel')}
                items={typeItems}
                value={strategyType}
                onValueChange={(v) => setStrategyType(v === 'aggressive' ? 'aggressive' : 'stable')}
              />
              <Button type="submit" variant="primary" loading={busy} disabled={busy}>
                {t('create')}
              </Button>
            </form>
          ) : null}
          {pool ? (
            <section aria-label={t('poolTitle', { name: pool.name })}>
              <h2>{t('poolTitle', { name: pool.name })}</h2>
              <dl>
                <dt>{t('poolState')}</dt>
                <dd>{pool.state === 'strategy_creation' ? t('stateStrategyCreation') : t('stateOther')}</dd>
                <dt>{t('poolType')}</dt>
                <dd>{pool.strategyType === 'stable' ? t('stable') : t('aggressive')}</dd>
                <dt>{t('poolLimits')}</dt>
                <dd>
                  {t('limitsValue', {
                    leverage: pool.limits.maxLeverage,
                    drawdown: pool.limits.maxDrawdownPct,
                    capital: pool.limits.maxCapital,
                  })}
                </dd>
              </dl>
              <h3>{t('investorsTitle')}</h3>
              {current && current.investors === 0 ? <p>{t('noInvestors')}</p> : null}
              <p>{t('moneyNote')}</p>
            </section>
          ) : null}
        </div>
      }
      summary={
        <div>
          <h2>{t('summaryTitle')}</h2>
          <p>{t('summaryReview')}</p>
          <p>{t('summaryWhitelist')}</p>
        </div>
      }
    />
  );
}
