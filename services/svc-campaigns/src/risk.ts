import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import {
  LedgerError,
  REWARD_ASSET,
  classifyPostOutcome,
  formatAmount,
  parseAmount,
  recipes,
  type LedgerClient,
} from '@intafaced/ledger-client';
import type {
  MyRiskCase,
  RiskAction,
  RiskCase,
  RiskQueue,
  RiskSignalInput,
  RiskSignalKind,
  RiskSignalResult,
  RiskStanding,
} from '@intafaced/contracts/campaigns-risk';
import type { RewardState } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';
import type { ParticipantSource } from './participants.js';
import { ledgerRewardId, type GateVerdict, type PayoutSaga, type RewardGate } from './payouts.js';

/**
 * The risk review of campaign rewards (J-campaigns-18, CM-abuse-fraud-01 and -02). It moves value only through one
 * ledger-client recipe, `rewardReclaim`, and only for an owed reward a person revoked.
 *
 * - Signals (`risk_signals`) are stored once by (kind, subject, account): the same signal sent twice is one row. Each
 *   account is judged on its own distinct signals only.
 * - The gate (`judge`, run by the reward saga before anything is owed or posted): an account that is not active (frozen
 *   or closed, svc-identity's) has its reward withheld with that cause; one whose signals reached the owner's threshold
 *   (`CAMPAIGNS_RISK_SIGNAL_THRESHOLD`) has it held for review (`review`, reason `risk.review`), keeping its budget place;
 *   one with any signal while the threshold is blank waits (`campaigns.risk_threshold_unset`), never paid as if the control
 *   were off. An account whose appeal was overturned passes. An account svc-identity did not answer for waits.
 * - Withholding a reward held for review keeps it `review` with reason `risk.withheld` and its budget place: no ledger call.
 * - Revoking (a disqualification) refuses while the owner's appeal window (`CAMPAIGNS_RISK_APPEAL_WINDOW_SECONDS`) is
 *   blank. It flags the account, and for each owed USDC reward whose payment has not started it moves the reward to
 *   `reclaiming` under a lock on the reward row (the payer takes the same lock before it records a payment, so of the two
 *   only one ever wins), writes the reclaim row, then posts `rewardReclaim` for the reward's amount, which is what is
 *   still owed: only the ledger's answer makes it `cancelled`. A lost answer leaves it `reclaiming`, and the next revoke
 *   posts the same key. A reward already paid to the customer's own wallet is never pulled back: the case records its
 *   amount, once per reward.
 * - An appeal is the customer's, filed once inside the window after the revocation; it is decided by an operator other
 *   than the one who revoked. Overturned, the account is unflagged and its rewards held for review are released to the
 *   saga; a reward already cancelled stays cancelled.
 */

type Sql = postgres.Sql;

export interface RiskOptions {
  sql: Sql;
  ledger: LedgerClient | null;
  participants: ParticipantSource | null;
  /** Owner value: how many distinct signals hold an account's rewards for review. Null: blank, which refuses. */
  threshold: number | null;
  /** Owner value: seconds after a revocation in which the customer may appeal. Null: blank, which refuses revoking. */
  appealWindowSeconds: number | null;
  now?: () => Date;
}

type CaseRow = {
  account_id: string;
  flagged: boolean;
  revoked_by: string | null;
  revoked_at: Date | null;
  appeal_until: Date | null;
};

type AppealRow = {
  text: string;
  filed_at: Date;
  decided_by: string | null;
  outcome: 'upheld' | 'overturned' | null;
  decision_reason: string | null;
  decided_at: Date | null;
};

type RewardRow = {
  reward_key: string;
  campaign_id: string;
  account_id: string;
  asset: string;
  amount: string;
  state: RewardState;
  reason: string | null;
  form: string;
  paid_chain_tx: string | null;
};

export const RISK_REVIEW = 'risk.review';
export const RISK_WITHHELD = 'risk.withheld';
export const RISK_REVOKED = 'risk.revoked';
export const THRESHOLD_UNSET = 'campaigns.risk_threshold_unset';

export class RiskService implements RewardGate {
  private readonly sql: Sql;
  private readonly ledger: LedgerClient | null;
  private readonly participants: ParticipantSource | null;
  readonly threshold: number | null;
  readonly appealWindowSeconds: number | null;
  private readonly now: () => Date;
  private saga: PayoutSaga | null = null;

  constructor(options: RiskOptions) {
    this.sql = options.sql;
    this.ledger = options.ledger;
    this.participants = options.participants;
    this.threshold = options.threshold;
    this.appealWindowSeconds = options.appealWindowSeconds;
    this.now = options.now ?? (() => new Date());
  }

  /** The saga releases a reward an overturned appeal frees (the saga is built with this service as its gate). */
  useSaga(saga: PayoutSaga): void {
    this.saga = saga;
  }

  // ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────────

  async judge(accountId: string): Promise<GateVerdict> {
    if (this.participants) {
      const who = await this.participants.read(accountId);
      if (!who) return { kind: 'wait', reason: 'campaigns.participant_unread' };
      if (who.status !== 'active') return { kind: 'withhold', reason: `account.${who.status}` };
    }
    const [row] = await this.sql<{ n: number; overturned: boolean }[]>`
      SELECT (SELECT count(*)::int FROM campaigns.risk_signals WHERE account_id = ${accountId}) AS n,
        EXISTS (SELECT 1 FROM campaigns.risk_appeals WHERE account_id = ${accountId} AND outcome = 'overturned') AS overturned`;
    if (!row || row.n === 0 || row.overturned) return { kind: 'pass' };
    if (this.threshold === null) return { kind: 'wait', reason: THRESHOLD_UNSET };
    return row.n >= this.threshold ? { kind: 'hold', reason: RISK_REVIEW } : { kind: 'pass' };
  }

  private standingOf(signals: number): RiskStanding {
    if (signals === 0) return 'watching';
    if (this.threshold === null) return 'unset';
    return signals >= this.threshold ? 'held' : 'watching';
  }

  // ── Signals ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  async recordSignal(input: RiskSignalInput, actor: string): Promise<RiskSignalResult> {
    const recorded: RiskSignalResult['recorded'] = [];
    for (const accountId of [...new Set(input.accountIds)]) {
      const made = await this.sql`
        INSERT INTO campaigns.risk_signals (kind, subject, account_id, note, recorded_by)
        VALUES (${input.kind}, ${input.subject}, ${accountId}, ${input.note ?? null}, ${actor})
        ON CONFLICT (kind, subject, account_id) DO NOTHING`;
      recorded.push({ accountId, created: made.count > 0 });
    }
    return { recorded };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every account with a signal, or with a reward withheld because it is not active, newest first. */
  async queue(): Promise<RiskQueue> {
    const rows = await this.sql<
      { account_id: string; kinds: RiskSignalKind[] | null; n: number; causes: string[] | null; flagged: boolean | null; last_at: Date }[]
    >`
      WITH accounts AS (
        SELECT account_id, created_at AS at FROM campaigns.risk_signals
        UNION ALL
        SELECT account_id, updated_at AS at FROM campaigns.reward_intents WHERE state = 'withheld' AND reason LIKE 'account.%'
      )
      SELECT a.account_id, max(a.at) AS last_at,
        (SELECT array_agg(DISTINCT s.kind ORDER BY s.kind) FROM campaigns.risk_signals s WHERE s.account_id = a.account_id) AS kinds,
        (SELECT count(*)::int FROM campaigns.risk_signals s WHERE s.account_id = a.account_id) AS n,
        (SELECT array_agg(DISTINCT i.reason ORDER BY i.reason) FROM campaigns.reward_intents i
          WHERE i.account_id = a.account_id AND i.state = 'withheld' AND i.reason LIKE 'account.%') AS causes,
        (SELECT c.flagged FROM campaigns.risk_cases c WHERE c.account_id = a.account_id) AS flagged
      FROM accounts a GROUP BY a.account_id ORDER BY max(a.at) DESC, a.account_id LIMIT 200`;
    return {
      threshold: this.threshold,
      appealWindowSeconds: this.appealWindowSeconds,
      rows: rows.map((r) => ({
        accountId: r.account_id,
        standing: this.standingOf(r.n),
        kinds: r.kinds ?? [],
        signals: r.n,
        causes: r.causes ?? [],
        flagged: r.flagged ?? false,
        lastAt: r.last_at.toISOString(),
      })),
    };
  }

  async caseOf(accountId: string): Promise<RiskCase> {
    const signals = await this.sql<
      {
        kind: RiskSignalKind;
        subject: string;
        account_id: string;
        note: string | null;
        recorded_by: string;
        created_at: Date;
        shared: string[] | null;
      }[]
    >`
      SELECT s.kind, s.subject, s.account_id, s.note, s.recorded_by, s.created_at,
        (SELECT array_agg(o.account_id ORDER BY o.account_id) FROM campaigns.risk_signals o
          WHERE o.kind = s.kind AND o.subject = s.subject AND o.account_id <> s.account_id) AS shared
      FROM campaigns.risk_signals s WHERE s.account_id = ${accountId} ORDER BY s.created_at, s.kind, s.subject`;
    const rewards = await this.rewardsOf(this.sql, accountId);
    const [c] = await this.sql<CaseRow[]>`SELECT * FROM campaigns.risk_cases WHERE account_id = ${accountId}`;
    const causes = [...new Set(rewards.filter((r) => r.state === 'withheld' && r.reason?.startsWith('account.')).map((r) => r.reason!))];
    if (signals.length === 0 && !c && causes.length === 0) {
      throw new CampaignsError('campaigns.risk_case_unknown', 'This account has no risk signal, case or withheld reward');
    }
    const [appeal] = await this.sql<AppealRow[]>`SELECT * FROM campaigns.risk_appeals WHERE account_id = ${accountId}`;
    const actions = await this.sql<
      {
        action: RiskAction['action'];
        reward_key: string | null;
        amount: string | null;
        actor: string;
        reason: string | null;
        ledger_tx_id: string | null;
        created_at: Date;
      }[]
    >`
      SELECT action, reward_key, amount::text AS amount, actor, reason, ledger_tx_id, created_at
      FROM campaigns.risk_actions WHERE account_id = ${accountId} ORDER BY id`;
    const paid = await this.sql<{ asset: string; amount: string }[]>`
      SELECT i.asset, sum(a.amount)::text AS amount FROM campaigns.risk_actions a
      JOIN campaigns.reward_intents i ON i.reward_key = a.reward_key
      WHERE a.account_id = ${accountId} AND a.action = 'record_paid' GROUP BY i.asset ORDER BY i.asset`;
    return {
      accountId,
      standing: this.standingOf(signals.length),
      threshold: this.threshold,
      signals: signals.map((s) => ({
        kind: s.kind,
        subject: s.subject,
        accountId: s.account_id,
        sharedWith: s.shared ?? [],
        note: s.note,
        recordedBy: s.recorded_by,
        at: s.created_at.toISOString(),
      })),
      causes,
      rewards: rewards.map((r) => ({
        rewardKey: r.reward_key,
        campaignId: r.campaign_id,
        asset: r.asset,
        amount: formatAmount(parseAmount(r.amount)),
        state: r.state,
        reason: r.reason,
        paidChainTx: r.paid_chain_tx,
      })),
      flagged: c?.flagged ?? false,
      revokedBy: c?.revoked_by ?? null,
      revokedAt: c?.revoked_at?.toISOString() ?? null,
      appealUntil: c?.appeal_until?.toISOString() ?? null,
      paidUnrecoverable: paid.map((p) => ({ asset: p.asset, amount: formatAmount(parseAmount(p.amount)) })),
      appeal: appeal ? appealOf(appeal) : null,
      actions: actions.map((a) => ({
        action: a.action,
        rewardKey: a.reward_key,
        amount: a.amount === null ? null : formatAmount(parseAmount(a.amount)),
        actor: a.actor,
        reason: a.reason,
        ledgerTxId: a.ledger_tx_id,
        at: a.created_at.toISOString(),
      })),
    };
  }

  async mine(accountId: string): Promise<MyRiskCase> {
    const [c] = await this.sql<CaseRow[]>`SELECT * FROM campaigns.risk_cases WHERE account_id = ${accountId}`;
    const [appeal] = await this.sql<AppealRow[]>`SELECT * FROM campaigns.risk_appeals WHERE account_id = ${accountId}`;
    return {
      flagged: c?.flagged ?? false,
      revokedAt: c?.revoked_at?.toISOString() ?? null,
      appealUntil: c?.appeal_until?.toISOString() ?? null,
      appeal: appeal ? appealOf(appeal) : null,
    };
  }

  private rewardsOf(sql: Sql, accountId: string) {
    return sql<RewardRow[]>`
      SELECT reward_key, campaign_id, account_id, asset, amount::text AS amount, state, reason, form, paid_chain_tx
      FROM campaigns.reward_intents WHERE account_id = ${accountId} ORDER BY created_at, reward_key LIMIT 500`;
  }

  // ── Decisions ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Withholds a reward held for review: it stays held with its budget place, and nothing is posted. */
  async withhold(input: { rewardKey: string; reason: string; actor: string }): Promise<RiskCase> {
    const accountId = await transaction(this.sql, async (tx) => {
      const [row] = await tx<RewardRow[]>`
        SELECT reward_key, campaign_id, account_id, asset, amount::text AS amount, state, reason, form, paid_chain_tx
        FROM campaigns.reward_intents WHERE reward_key = ${input.rewardKey} FOR UPDATE`;
      if (!row || row.state !== 'review') {
        throw new CampaignsError('campaigns.risk_reward_not_held', 'Only a reward held for risk review can be withheld');
      }
      if (row.reason === RISK_WITHHELD) return row.account_id;
      await tx`
        UPDATE campaigns.reward_intents SET reason = ${RISK_WITHHELD}, updated_at = now()
        WHERE reward_key = ${row.reward_key} AND state = 'review'`;
      await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${row.reward_key}, 'withheld', ${RISK_WITHHELD})`;
      await this.openCase(tx, row.account_id);
      await tx`
        INSERT INTO campaigns.risk_actions (account_id, action, reward_key, amount, actor, reason)
        VALUES (${row.account_id}, 'withhold', ${row.reward_key}, ${row.amount}, ${input.actor}, ${input.reason})
        ON CONFLICT DO NOTHING`;
      return row.account_id;
    });
    return this.caseOf(accountId);
  }

  /**
   * Revokes an account's rewards. Run again, it changes nothing already decided and finishes any reclaim whose answer was
   * lost (the same key).
   */
  async revoke(input: { accountId: string; reason: string; actor: string }): Promise<RiskCase> {
    if (this.appealWindowSeconds === null) {
      throw new CampaignsError('campaigns.appeal_window_unset', 'Rewards cannot be revoked while the appeal window is blank');
    }
    if (!this.ledger) throw new CampaignsError('campaigns.reward_saga_unwired', 'The ledger is not wired');
    await this.caseOf(input.accountId);
    const now = this.now();
    const appealUntil = new Date(now.getTime() + this.appealWindowSeconds * 1000);
    await transaction(this.sql, async (tx) => {
      await this.openCase(tx, input.accountId);
      const revoked = await tx`
        UPDATE campaigns.risk_cases SET flagged = true, revoked_by = ${input.actor}, revoked_at = ${now},
          revoke_reason = ${input.reason}, appeal_until = ${appealUntil}, updated_at = now()
        WHERE account_id = ${input.accountId} AND revoked_at IS NULL`;
      if (revoked.count > 0) {
        await tx`
          INSERT INTO campaigns.risk_actions (account_id, action, actor, reason)
          VALUES (${input.accountId}, 'revoke', ${input.actor}, ${input.reason})`;
      }
      // A reward already paid to the customer's own wallet is never pulled back: its amount is on the case, once.
      await tx`
        INSERT INTO campaigns.risk_actions (account_id, action, reward_key, amount, actor, reason)
        SELECT account_id, 'record_paid', reward_key, amount, ${input.actor}, 'Paid to the customer''s own wallet; not pulled back'
        FROM campaigns.reward_intents WHERE account_id = ${input.accountId} AND state = 'paid'
        ON CONFLICT DO NOTHING`;
    });
    const owed = await this.sql<{ reward_key: string }[]>`
      SELECT reward_key FROM campaigns.reward_intents
      WHERE account_id = ${input.accountId} AND state IN ('owed', 'reclaiming') AND form = 'paid' AND asset = ${REWARD_ASSET}
      ORDER BY created_at, reward_key`;
    for (const { reward_key: key } of owed) await this.cancelOwed(key, input.accountId, input.actor);
    return this.caseOf(input.accountId);
  }

  /** One owed reward: claimed for reclaiming under its row lock if no payment started, then reclaimed once. */
  private async cancelOwed(rewardKey: string, accountId: string, actor: string): Promise<void> {
    const claimed = await transaction(this.sql, async (tx) => {
      const [row] = await tx<RewardRow[]>`
        SELECT reward_key, campaign_id, account_id, asset, amount::text AS amount, state, reason, form, paid_chain_tx
        FROM campaigns.reward_intents WHERE reward_key = ${rewardKey} FOR UPDATE`;
      if (!row) return null;
      if (row.state === 'reclaiming') return row;
      if (row.state !== 'owed') return null;
      // Read after the lock: a payment the payer recorded first is seen here, and that reward is the payer's.
      const [paying] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM campaigns.reward_payments WHERE reward_key = ${rewardKey}`;
      if (paying && paying.n > 0) return null;
      await tx`
        UPDATE campaigns.reward_intents SET state = 'reclaiming', reason = ${RISK_REVOKED}, updated_at = now()
        WHERE reward_key = ${rewardKey} AND state = 'owed'`;
      await tx`
        INSERT INTO campaigns.risk_reclaims (reward_key, account_id, amount) VALUES (${rewardKey}, ${accountId}, ${row.amount})
        ON CONFLICT (reward_key) DO NOTHING`;
      return row;
    });
    if (!claimed) return;
    const [reclaim] = await this.sql<{ amount: string; state: string; reason: string | null }[]>`
      SELECT amount::text AS amount, state, reason FROM campaigns.risk_reclaims WHERE reward_key = ${rewardKey}`;
    if (!reclaim || reclaim.state === 'posted') return;
    let txId: string;
    try {
      const posted = await this.ledger!.post(
        recipes.rewardReclaim({
          campaignId: claimed.campaign_id,
          rewardId: ledgerRewardId(claimed.campaign_id, rewardKey),
          caseId: `risk-${accountId}`,
          assetId: REWARD_ASSET,
          amount: parseAmount(reclaim.amount),
        }),
      );
      txId = posted.id;
    } catch (err) {
      // Refused or lost: it stays reclaiming, never paid; the next revoke posts the same key.
      const code = err instanceof LedgerError ? err.code : 'ledger.answer_lost';
      const refused = err instanceof LedgerError && classifyPostOutcome(err) === 'refused';
      await this.sql`
        UPDATE campaigns.risk_reclaims SET state = ${refused ? 'refused' : 'posting'}, reason = ${code}, updated_at = now()
        WHERE reward_key = ${rewardKey} AND state <> 'posted'`;
      return;
    }
    await transaction(this.sql, async (tx) => {
      const done = await tx`
        UPDATE campaigns.risk_reclaims SET state = 'posted', ledger_tx_id = ${txId}, reason = NULL, updated_at = now()
        WHERE reward_key = ${rewardKey} AND state <> 'posted'`;
      if (done.count === 0) return;
      await tx`
        UPDATE campaigns.reward_intents SET state = 'cancelled', reason = ${RISK_REVOKED}, updated_at = now()
        WHERE reward_key = ${rewardKey} AND state = 'reclaiming'`;
      await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${rewardKey}, 'cancelled', ${RISK_REVOKED})`;
      await tx`
        INSERT INTO campaigns.risk_actions (account_id, action, reward_key, amount, actor, reason, ledger_tx_id)
        VALUES (${accountId}, 'cancel', ${rewardKey}, ${reclaim.amount}, ${actor}, 'Owed and not paid: cancelled', ${txId})
        ON CONFLICT DO NOTHING`;
    });
  }

  /** The customer's own appeal, once per case, inside the window after their rewards were revoked. */
  async appeal(input: { accountId: string; text: string }): Promise<MyRiskCase> {
    await transaction(this.sql, async (tx) => {
      const [c] = await tx<CaseRow[]>`SELECT * FROM campaigns.risk_cases WHERE account_id = ${input.accountId} FOR UPDATE`;
      if (!c?.revoked_at || !c.appeal_until) {
        throw new CampaignsError('campaigns.appeal_not_open', 'There is no revocation of your rewards to appeal');
      }
      const [filed] = await tx<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM campaigns.risk_appeals WHERE account_id = ${input.accountId}`;
      if (filed && filed.n > 0) return;
      if (this.now().getTime() > c.appeal_until.getTime()) {
        throw new CampaignsError('campaigns.appeal_window_closed', 'The appeal window for this decision has closed');
      }
      await tx`INSERT INTO campaigns.risk_appeals (account_id, text) VALUES (${input.accountId}, ${input.text})`;
      await tx`
        INSERT INTO campaigns.risk_actions (account_id, action, actor, reason)
        VALUES (${input.accountId}, 'appeal', ${input.accountId}, ${input.text})`;
    });
    return this.mine(input.accountId);
  }

  /** A second person decides the appeal: never the operator who revoked. */
  async decideAppeal(input: { accountId: string; outcome: 'upheld' | 'overturned'; reason: string; actor: string }): Promise<RiskCase> {
    const released = await transaction(this.sql, async (tx) => {
      const [c] = await tx<CaseRow[]>`SELECT * FROM campaigns.risk_cases WHERE account_id = ${input.accountId} FOR UPDATE`;
      const [a] = await tx<AppealRow[]>`SELECT * FROM campaigns.risk_appeals WHERE account_id = ${input.accountId} FOR UPDATE`;
      if (!c || !a || a.decided_by !== null) {
        throw new CampaignsError('campaigns.appeal_not_open', 'There is no appeal waiting for a decision on this account');
      }
      if (c.revoked_by === input.actor) {
        throw new CampaignsError('campaigns.appeal_same_person', 'The operator who revoked these rewards cannot decide their appeal');
      }
      await tx`
        UPDATE campaigns.risk_appeals SET decided_by = ${input.actor}, outcome = ${input.outcome},
          decision_reason = ${input.reason}, decided_at = now()
        WHERE account_id = ${input.accountId} AND decided_by IS NULL`;
      await tx`
        INSERT INTO campaigns.risk_actions (account_id, action, actor, reason)
        VALUES (${input.accountId}, 'appeal_decided', ${input.actor}, ${`${input.outcome}: ${input.reason}`})`;
      if (input.outcome === 'upheld') return [];
      await tx`UPDATE campaigns.risk_cases SET flagged = false, updated_at = now() WHERE account_id = ${input.accountId}`;
      const freed = await tx<{ reward_key: string }[]>`
        UPDATE campaigns.reward_intents SET state = 'qualified', reason = NULL, updated_at = now()
        WHERE account_id = ${input.accountId} AND state = 'review' RETURNING reward_key`;
      for (const f of freed) {
        await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${f.reward_key}, 'released')`;
      }
      return freed.map((f) => f.reward_key);
    });
    for (const key of released) await this.saga?.attempt(key);
    return this.caseOf(input.accountId);
  }

  private async openCase(tx: Sql, accountId: string): Promise<void> {
    await tx`INSERT INTO campaigns.risk_cases (account_id) VALUES (${accountId}) ON CONFLICT (account_id) DO NOTHING`;
  }
}

function appealOf(a: AppealRow) {
  return {
    filedAt: a.filed_at.toISOString(),
    text: a.text,
    decidedBy: a.decided_by,
    outcome: a.outcome,
    decisionReason: a.decision_reason,
    decidedAt: a.decided_at?.toISOString() ?? null,
  };
}
