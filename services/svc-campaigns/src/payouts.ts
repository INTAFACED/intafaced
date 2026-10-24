import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
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
 * through two ledger-client recipes.
 *
 * - `rewardPay` pays a claimed reward from the one reward pot to the customer's available balance, under the ledger key
 *   `reward:<reward_key>` (`reward_key` is `task:<campaign>:<account>:<period>`, a business key, never a clock or a
 *   random id).
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

export type PostAnswer =
  { state: 'posted'; txId: string } | { state: 'pending_funding' | 'pending_retry' | 'unknown' | 'failed'; reason: string };

type IntentRow = {
  reward_key: string;
  account_id: string;
  asset: string;
  amount: string;
  attempts: number;
};

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
    const stale = this.reconcileAfterSeconds ?? 0;
    const [row] = await this.sql<IntentRow[]>`
      UPDATE campaigns.reward_intents
      SET state = 'posting', attempts = attempts + 1, last_attempt_at = now(), updated_at = now()
      WHERE reward_key = ${rewardKey} AND (
        state = 'qualified'
        OR (${retry} AND state IN ${this.sql(RETRYABLE)})
        OR (${retry} AND state = 'posting' AND last_attempt_at < now() - make_interval(secs => ${stale}))
      )
      RETURNING reward_key, account_id, asset, amount::text AS amount, attempts`;
    if (!row) return false;
    let answer: PostAnswer;
    try {
      const tx = await this.ledger.post(
        recipes.rewardPay({
          rewardId: row.reward_key,
          userId: row.account_id,
          assetId: row.asset,
          amount: parseAmount(row.amount),
          reason: REWARD_REASON,
        }),
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
        await tx`
          UPDATE campaigns.reward_intents SET state = 'posted', reason = NULL, ledger_tx_id = ${answer.txId},
            posted_at = now(), updated_at = now()
          WHERE reward_key = ${rewardKey} AND state = 'posting'`;
        await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${rewardKey}, 'posted')`;
        return;
      }
      await tx`
        UPDATE campaigns.reward_intents SET state = ${answer.state}, reason = ${answer.reason}, updated_at = now()
        WHERE reward_key = ${rewardKey} AND state = 'posting'`;
      const outcome = answer.state === 'unknown' ? 'unknown' : 'refused';
      await tx`
        INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${rewardKey}, ${outcome}, ${answer.reason})`;
    });
  }

  /** One approved pot funding. Only `posting` rows post; a refusal is final for that reference. */
  async fund(reference: string, { retry = false }: { retry?: boolean } = {}): Promise<boolean> {
    const stale = this.reconcileAfterSeconds ?? 0;
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
        WHERE reference = ${reference} AND state = 'posting'`;
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
      WHERE state IN ${this.sql([...RETRYABLE, 'posting'])}
        AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(secs => ${after}))
      ORDER BY created_at LIMIT ${limit}`;
    let posted = 0;
    for (const { reward_key } of intents) if (await this.attempt(reward_key, { retry: true })) posted += 1;
    const fundings = await this.sql<{ reference: string }[]>`
      SELECT reference FROM campaigns.pot_fundings
      WHERE state IN ('posting', 'unknown') AND last_attempt_at < now() - make_interval(secs => ${after})
      ORDER BY created_at LIMIT ${limit}`;
    let funded = 0;
    for (const { reference } of fundings) if (await this.fund(reference, { retry: true })) funded += 1;
    return { intents: posted, fundings: funded };
  }
}
