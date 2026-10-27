import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { POST_DEADLINE_SECONDS } from './ledger-client.js';
import {
  LedgerError,
  classifyPostOutcome,
  parseAmount,
  provesPostNotCommitted,
  recipes,
  type LedgerClient,
} from '@intafaced/ledger-client';

/**
 * The reward saga (CM-payouts-ledger-02, ENGINE RW-1 to RW-8): the only place svc-campaigns moves value, and only
 * through ledger-client recipes.
 *
 * - `rewardPay` pays a claimed reward from the one reward pot to the customer's available balance, under the ledger key
 *   `reward:<reward_key>` (`reward_key` is `task:<campaign>:<account>:<period>`, a business key, never a clock or a
 *   random id).
 * - A reward the campaign gives locked or as a bonus goes into its own campaigns pot with `campaignRewardLock`, under
 *   `campaigns:lock:<reward_key>`, never to the customer's balance; its outcome is `campaignRewardUnlock` (to the
 *   customer) or `campaignRewardForfeit` (back to the reward pot), each under its own key (`settle`).
 * - `sweepFeesToRewards` funds that pot from fee revenue the platform earned, once two operators agree, under
 *   `token.fee.sweep:campaigns:<reference>:<module>:<asset>`.
 *
 * Order, every time: the intent row (and its terms) is written and committed first; then the row is moved to `posting`
 * by one conditional UPDATE, so of two attempts at once only one posts; then the post, with no transaction open; then the
 * answer is written. A retry always posts the SAME key with the SAME stored terms, so the ledger answers a post that had
 * landed with its original transaction and books nothing twice.
 *
 * Answers: booked is `posted`. The pot not covering it (`ledger.insufficient_funds`) is `pending_funding`; the platform
 * posting freeze (`ledger.frozen`) is `pending_retry`; both post again later under the same key. Another definite
 * refusal of a first single attempt proves nothing was booked and is `failed` (the budget it held is released). Anything
 * else is `unknown`: the intent and its budget stay, and only the reconciler posts the same key again. Nothing marks an
 * intent posted except the ledger's own answer, and no person can.
 */

type Sql = postgres.Sql;

export const REWARD_REASON = 'campaigns.task.reward';
/** States the reconciler may post again. `posting` only once its last attempt is older than the interval (a crash). */
const RETRYABLE = ['qualified', 'pending_funding', 'pending_retry', 'unknown'] as const;
const OPEN = [...RETRYABLE, 'posting'] as const;

/** A `posting` row is taken again only once its attempt can no longer be waiting on the ledger. */
const inFlightAfter = (reconcileAfterSeconds: number | null) => Math.max(reconcileAfterSeconds ?? 0, POST_DEADLINE_SECONDS);

export type PostAnswer =
  { state: 'posted'; txId: string } | { state: 'pending_funding' | 'pending_retry' | 'unknown' | 'failed'; reason: string };

type IntentRow = {
  reward_key: string;
  account_id: string;
  asset: string;
  amount: string;
  attempts: number;
  form: 'paid' | 'locked' | 'bonus';
};

type SettleRow = { reward_key: string; account_id: string; asset: string; amount: string; settle: 'unlock' | 'forfeit'; form: string };

type FundingRow = { reference: string; source_module: string; asset: string; amount: string; attempts: number };

/** The ledger's code for a refusal, or a plain name for a lost answer. */
function codeOf(err: unknown): string {
  return err instanceof LedgerError ? err.code : 'ledger.answer_lost';
}

/** How one failed post is recorded. `firstAttempt`: this is the first post ever made under the key. */
export function answerOf(err: unknown, firstAttempt: boolean): PostAnswer {
  const code = codeOf(err);
  if (classifyPostOutcome(err) === 'refused') {
    if (code === 'ledger.insufficient_funds') return { state: 'pending_funding', reason: code };
    if (code === 'ledger.frozen') return { state: 'pending_retry', reason: code };
    if (firstAttempt && provesPostNotCommitted(err)) return { state: 'failed', reason: code };
  }
  return { state: 'unknown', reason: code };
}

export interface PayoutSagaOptions {
  sql: Sql;
  ledger: LedgerClient;
  /** Owner value: seconds after an attempt before the reconciler posts the same key again. Null: no reconciler. */
  reconcileAfterSeconds: number | null;
}

export class PayoutSaga {
  readonly reconcileAfterSeconds: number | null;
  private readonly sql: Sql;
  private readonly ledger: LedgerClient;

  constructor(options: PayoutSagaOptions) {
    this.sql = options.sql;
    this.ledger = options.ledger;
    this.reconcileAfterSeconds = options.reconcileAfterSeconds;
  }

  /**
   * One attempt at one intent. `retry` lets the reconciler take a retryable intent (and a `posting` one whose attempt
   * is older than the interval); a claim takes only a fresh `qualified` one. Returns false when another attempt holds it.
   */
  async attempt(rewardKey: string, { retry = false }: { retry?: boolean } = {}): Promise<boolean> {
    const stale = inFlightAfter(this.reconcileAfterSeconds);
    const [row] = await this.sql<IntentRow[]>`
      UPDATE campaigns.reward_intents
      SET state = 'posting', attempts = attempts + 1, last_attempt_at = now(), updated_at = now()
      WHERE reward_key = ${rewardKey} AND (
        state = 'qualified'
        OR (${retry} AND state IN ${this.sql(RETRYABLE)})
        OR (${retry} AND state = 'posting' AND last_attempt_at < now() - make_interval(secs => ${stale}))
      )
      RETURNING reward_key, account_id, asset, amount::text AS amount, attempts, form`;
    if (!row) return false;
    let answer: PostAnswer;
    try {
      const terms = { userId: row.account_id, assetId: row.asset, amount: parseAmount(row.amount) };
      // A locked reward or a bonus goes into its own campaigns pot, never to the customer's balance.
      const tx = await this.ledger.post(
        row.form === 'paid'
          ? recipes.rewardPay({ ...terms, rewardId: row.reward_key, reason: REWARD_REASON })
          : recipes.campaignRewardLock({ ...terms, rewardKey: row.reward_key }),
      );
      answer = { state: 'posted', txId: tx.id };
    } catch (err) {
      answer = answerOf(err, row.attempts === 1);
    }
    await this.recordIntent(row.reward_key, answer);
    return true;
  }

  private async recordIntent(rewardKey: string, answer: PostAnswer): Promise<void> {
    await transaction(this.sql, async (tx) => {
      if (answer.state === 'posted') {
        // The ledger booked it: that answer stands over any open state an overlapping attempt wrote first. A lock's
        // booking makes the reward `locked` until its condition ends, counted from now.
        const booked = await tx<{ form: string }[]>`
          UPDATE campaigns.reward_intents SET
            state = CASE WHEN form = 'paid' THEN 'posted' ELSE 'locked' END,
            ledger_tx_id = CASE WHEN form = 'paid' THEN ${answer.txId} ELSE NULL END,
            posted_at = CASE WHEN form = 'paid' THEN now() ELSE NULL END,
            lock_tx_id = CASE WHEN form = 'paid' THEN NULL ELSE ${answer.txId} END,
            locked_at = CASE WHEN form = 'paid' THEN NULL ELSE now() END,
            lock_until = CASE WHEN form = 'paid' THEN NULL ELSE now() + make_interval(secs => lock_seconds) END,
            reason = NULL, updated_at = now()
          WHERE reward_key = ${rewardKey} AND state IN ${tx(OPEN)}
          RETURNING form`;
        if (booked[0]) {
          const outcome = booked[0].form === 'paid' ? 'posted' : 'locked';
          await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${rewardKey}, ${outcome})`;
        }
        return;
      }
      const moved = await tx`
        UPDATE campaigns.reward_intents SET state = ${answer.state}, reason = ${answer.reason}, updated_at = now()
        WHERE reward_key = ${rewardKey} AND state = 'posting'`;
      if (moved.count === 0) return;
      const outcome = answer.state === 'unknown' ? 'unknown' : 'refused';
      await tx`
        INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${rewardKey}, ${outcome}, ${answer.reason})`;
    });
  }

  /**
   * One attempt at the decided outcome of a locked reward or bonus (`settling`, with `settle` written first): an unlock
   * pays its pot to the customer and the reward is `posted`; a forfeit returns its pot to the reward pot and the reward
   * is `forfeited`, never given again. Each outcome has its own key, so a retry books nothing twice. Any refusal or a
   * lost answer leaves it `settling` with the reason (logged as `refused` or `unknown`, once per new answer), and the
   * reconciler posts the same outcome again: the value never leaves the reward's pot until an outcome books.
   */
  async settle(rewardKey: string, { retry = false }: { retry?: boolean } = {}): Promise<boolean> {
    const stale = inFlightAfter(this.reconcileAfterSeconds);
    const [row] = await this.sql<SettleRow[]>`
      UPDATE campaigns.reward_intents SET last_attempt_at = now(), updated_at = now()
      WHERE reward_key = ${rewardKey} AND state = 'settling' AND (
        last_attempt_at IS NULL OR last_attempt_at < locked_at
        OR (${retry} AND last_attempt_at < now() - make_interval(secs => ${stale}))
      )
      RETURNING reward_key, account_id, asset, amount::text AS amount, settle, form`;
    if (!row) return false;
    const terms = { rewardKey: row.reward_key, userId: row.account_id, assetId: row.asset, amount: parseAmount(row.amount) };
    let txId: string | null = null;
    let reason: string;
    let refused = false;
    try {
      const tx = await this.ledger.post(
        row.settle === 'unlock' ? recipes.campaignRewardUnlock(terms) : recipes.campaignRewardForfeit(terms),
      );
      txId = tx.id;
      reason = row.settle === 'unlock' ? '' : row.form === 'bonus' ? 'campaigns.bonus_expired' : 'campaigns.lock_condition_failed';
    } catch (err) {
      reason = codeOf(err);
      refused = classifyPostOutcome(err) === 'refused';
    }
    await transaction(this.sql, async (tx) => {
      if (txId === null) {
        // The value stays in the reward's own pot either way, so the same outcome is posted again; the log gets a line
        // when the answer changes, not on every pass, and a refusal reads as one so an operator can see it.
        const kept = await tx`
          UPDATE campaigns.reward_intents SET reason = ${reason}, updated_at = now()
          WHERE reward_key = ${rewardKey} AND state = 'settling' AND reason IS DISTINCT FROM ${reason}`;
        if (kept.count > 0) {
          await tx`
            INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason)
            VALUES (${rewardKey}, ${refused ? 'refused' : 'unknown'}, ${reason})`;
        }
        return;
      }
      const unlock = row.settle === 'unlock';
      const booked = await tx`
        UPDATE campaigns.reward_intents SET state = ${unlock ? 'posted' : 'forfeited'}, reason = ${unlock ? null : reason},
          ledger_tx_id = ${txId}, posted_at = ${unlock ? new Date() : null}, updated_at = now()
        WHERE reward_key = ${rewardKey} AND state = 'settling'`;
      if (booked.count > 0) {
        await tx`
          INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason)
          VALUES (${rewardKey}, ${unlock ? 'unlocked' : 'forfeited'}, ${unlock ? null : reason})`;
      }
    });
    return true;
  }

  /** One approved pot funding. Only `posting` rows post; a refusal is final for that reference. */
  async fund(reference: string, { retry = false }: { retry?: boolean } = {}): Promise<boolean> {
    const stale = inFlightAfter(this.reconcileAfterSeconds);
    const [row] = await this.sql<FundingRow[]>`
      UPDATE campaigns.pot_fundings SET attempts = attempts + 1, last_attempt_at = now(), updated_at = now(), state = 'posting'
      WHERE reference = ${reference} AND approved_by IS NOT NULL AND (
        (state = 'posting' AND attempts = 0)
        OR (${retry} AND state = 'unknown')
        OR (${retry} AND state = 'posting' AND last_attempt_at < now() - make_interval(secs => ${stale}))
      )
      RETURNING reference, source_module, asset, amount::text AS amount, attempts`;
    if (!row) return false;
    let answer: PostAnswer;
    try {
      const tx = await this.ledger.post(
        recipes.sweepFeesToRewards({
          windowId: `campaigns:${row.reference}`,
          sourceModule: row.source_module,
          assetId: row.asset,
          amount: parseAmount(row.amount),
        }),
      );
      answer = { state: 'posted', txId: tx.id };
    } catch (err) {
      answer = answerOf(err, row.attempts === 1);
    }
    if (answer.state === 'posted') {
      await this.sql`
        UPDATE campaigns.pot_fundings SET state = 'posted', reason = NULL, ledger_tx_id = ${answer.txId}, updated_at = now()
        WHERE reference = ${reference} AND state IN ('posting', 'unknown')`;
    } else {
      // The fee account not covering it, or a proven refusal, ends this funding; anything else stays open.
      const final = answer.state === 'failed' || answer.state === 'pending_funding';
      await this.sql`
        UPDATE campaigns.pot_fundings SET state = ${final ? 'refused' : 'unknown'}, reason = ${answer.reason}, updated_at = now()
        WHERE reference = ${reference} AND state = 'posting'`;
    }
    return true;
  }

  /**
   * The reconciler (ENGINE RW-6, RW-7): every open intent and funding whose last attempt is older than the interval is
   * posted again under its own key. Two reconcilers at once take each row once (the conditional UPDATE above).
   */
  async reconcile(limit = 100): Promise<{ intents: number; fundings: number }> {
    if (this.reconcileAfterSeconds === null) return { intents: 0, fundings: 0 };
    const after = this.reconcileAfterSeconds;
    const intents = await this.sql<{ reward_key: string }[]>`
      SELECT reward_key FROM campaigns.reward_intents
      WHERE state IN ${this.sql(OPEN)}
        AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(secs => ${after}))
      ORDER BY created_at LIMIT ${limit}`;
    let posted = 0;
    for (const { reward_key } of intents) if (await this.attempt(reward_key, { retry: true })) posted += 1;
    // A decided outcome whose post failed or whose answer was lost.
    const settling = await this.sql<{ reward_key: string }[]>`
      SELECT reward_key FROM campaigns.reward_intents
      WHERE state = 'settling' AND last_attempt_at < now() - make_interval(secs => ${after})
      ORDER BY updated_at LIMIT ${limit}`;
    for (const { reward_key } of settling) if (await this.settle(reward_key, { retry: true })) posted += 1;
    const fundings = await this.sql<{ reference: string }[]>`
      SELECT reference FROM campaigns.pot_fundings
      WHERE state IN ('posting', 'unknown')
        AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(secs => ${after}))
      ORDER BY created_at LIMIT ${limit}`;
    let funded = 0;
    for (const { reference } of fundings) if (await this.fund(reference, { retry: true })) funded += 1;
    return { intents: posted, fundings: funded };
  }
}
