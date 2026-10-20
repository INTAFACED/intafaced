import { envScreeningList, screeningMoneyGrade } from '@intafaced/config/screening';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { enqueueHeldPayment } from '../fraud/review-queue-store.js';
import { PayGuardRefusal, type PartialPayGuards, type PayoutExecuteContext, type UserMoneyWithdrawalContext } from '../seams/guards.js';
import { applyListPosture, screeningCaseFromAnswer, type ScreeningAnswer, type ScreeningDecision } from './decision.js';
import {
  createSqlScreeningCaseStore,
  RELEASE_FACTOR,
  screeningSubjectKey,
  type ScreeningCaseRecord,
  type ScreeningCaseStore,
  type ScreeningSubjectKind,
} from './store.js';

export type { ScreeningAnswer, ScreeningCaseRecord, ScreeningCaseStore, ScreeningSubjectKind };
export { screeningSubjectKey };

/** Who is being screened. A supplier is asked about this subject; the answer never leaves a name or address in a case. */
export interface ScreeningSubject {
  readonly kind: ScreeningSubjectKind;
  readonly partyRef: string;
  readonly assetId: string;
  readonly amount: string;
}

export type ScreeningScreener = (subject?: ScreeningSubject) => Promise<ScreeningAnswer | null | undefined>;

export interface ScreeningGuardDeps {
  readonly sql: Sql;
  readonly store?: ScreeningCaseStore;
  /** Omitted in production: no supplier is connected, so the answer is no result. */
  readonly screener?: ScreeningScreener;
  /** Omitted in production: read from the sanctions list already configured for this process. */
  readonly listPosture?: 'blank' | 'named';
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  /** Which supplier the screener is, for the case record. Omitted: `none`. */
  readonly providerLabel?: string;
}

const RETRYABLE_PG = new Set(['40001', '40P01']);
const DEFAULT_TIMEOUT_MS = 5_000;

const noSupplier: ScreeningScreener = async () => null;

export function listPostureOf(deps: Pick<ScreeningGuardDeps, 'listPosture' | 'env'>): 'blank' | 'named' {
  if (deps.listPosture) return deps.listPosture;
  const grade = screeningMoneyGrade(envScreeningList(deps.env ?? process.env));
  return grade === 'counsel' ? 'named' : 'blank';
}

function refusalFor(decision: ScreeningDecision): PayGuardRefusal | null {
  if (decision.status === 'clear') return null;
  if (decision.status === 'refuse') return new PayGuardRefusal('pay.guard_screening_refuse', 'refused');
  if (decision.status === 'review') return new PayGuardRefusal('pay.guard_screening_review', 'unavailable');
  return new PayGuardRefusal('pay.guard_screening_unavailable', 'unavailable');
}

export async function answerFrom(
  screener: ScreeningScreener,
  timeoutMs: number,
  subject?: ScreeningSubject,
): Promise<ScreeningAnswer | null | undefined> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { category: 'unavailable', factors: [{ code: 'provider_down' }] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      screener(subject),
      new Promise<ScreeningAnswer>((resolve) => {
        timer = setTimeout(() => resolve({ category: 'unavailable', factors: [{ code: 'provider_down' }] }), timeoutMs);
      }),
    ]);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && RETRYABLE_PG.has(code)) throw error;
    return { category: 'unavailable', factors: [{ code: 'provider_down' }] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Screen one fresh or in-flight custodial send. A replay already left (or is
 * bookkeeping only) and is not refused again. Anything other than clear refuses
 * before the caller posts a ledger payout or hold.
 */
export function createScreeningGuards(deps: ScreeningGuardDeps): PartialPayGuards {
  const store = deps.store ?? createSqlScreeningCaseStore(deps.sql);
  const screener = deps.screener ?? noSupplier;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const posture = listPostureOf(deps);

  async function decide(
    kind: ScreeningSubjectKind,
    parts: readonly string[],
    replayKind: 'fresh' | 'replay' | 'recovery',
    party: { merchantId: string; amount: Amount; assetId: string },
    /** The caller's own transaction, when it has one. Only a withdrawal does, and only it can spend a release. */
    tx?: Sql,
  ): Promise<void> {
    if (replayKind === 'replay') return;
    const subjectKey = screeningSubjectKey(kind, parts);
    const context = { partyRef: party.merchantId, amount: formatAmount(party.amount), assetId: party.assetId };
    // A fresh send may spend a compliance release (a person decided a held send of this party was fine). Never on a blank
    // list: the list is the thing that cannot be argued with, and a release never touches the case it came from.
    if (tx && posture === 'named' && store.spendRelease) {
      // A send that already spent its release (the claim committed, then the process died) keeps it: a retry, whether
      // it classifies as recovery or still as fresh, is honoured from its own case and never spends a second one.
      const own = await store.read(kind, subjectKey);
      if (own?.status === 'clear' && own.factors.some((item) => item.code === RELEASE_FACTOR)) return;
      if (replayKind === 'fresh') {
        const from = await store.spendRelease(tx, { ...context, exceptKey: subjectKey });
        if (from !== null) {
          // The spend wrote this send's own clear case inside `tx`; a pool write here would wait on that uncommitted row.
          return;
        }
      }
    }
    const decision: ScreeningDecision = applyListPosture(
      screeningCaseFromAnswer(await answerFrom(screener, timeoutMs, { kind, ...context })),
      posture,
    );
    const record: ScreeningCaseRecord = {
      subjectKind: kind,
      subjectKey,
      status: decision.status,
      factors: decision.factors,
      context: { ...context, provider: deps.providerLabel ?? 'none' },
    };
    const refusal = refusalFor(decision);
    if (refusal) {
      refusal.afterRollback = async () => {
        await store.save(record);
        if (decision.status !== 'review') return;
        const codes = decision.factors.map((item) => item.code);
        const details = codes.length > 0 ? codes : ['screening_review'];
        await enqueueHeldPayment(deps.sql, {
          paymentRef: `screening:${kind}:${record.subjectKey}`,
          merchantId: party.merchantId,
          amount: formatAmount(party.amount),
          assetId: party.assetId,
          reason: details.join(', '),
          reasons: details.map((code) => ({ ruleId: 'screening_review', detail: code })),
          createdBy: 'screening',
          source: 'screening.review',
        });
      };
      throw refusal;
    }
    try {
      await store.save(record);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && RETRYABLE_PG.has(code)) throw error;
      throw new PayGuardRefusal('pay.guard_screening_unavailable', 'unavailable');
    }
  }

  return {
    beforePayoutExecute: (ctx: PayoutExecuteContext) =>
      decide('payout', [ctx.settlementId, String(ctx.attempt)], ctx.replay.kind, {
        merchantId: ctx.merchantId,
        amount: ctx.amount,
        assetId: ctx.assetId,
      }),
    beforeUserMoneyWithdrawal: (ctx: UserMoneyWithdrawalContext) =>
      decide(
        'withdrawal',
        [ctx.userId, ctx.clientRef],
        ctx.replay.kind,
        { merchantId: ctx.userId, amount: ctx.amount, assetId: ctx.assetId },
        ctx.tx,
      ),
  };
}
