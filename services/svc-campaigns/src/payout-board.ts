import type postgres from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { RedemptionAttempt, RewardState } from '@intafaced/contracts/campaigns-rewards';
import {
  PAYOUT_BOARD_STATES,
  type PayoutBoard,
  type PayoutBoardRow,
  type PayoutBoardState,
} from '@intafaced/contracts/campaigns-payout-board';

/**
 * The payout board (J-campaigns-19 #1 #2): every reward intent where finance reads it on its way to the customer's own
 * wallet, with its keys, its ledger transactions, its one payment and that payment's chain transaction. Read only, from
 * svc-campaigns' own rows (`reward_intents`, `reward_payments`, `redemption_attempts`); it moves nothing.
 *
 * The board state is derived, never stored: `paid` and `failed` and `pending_funding` are the intent's own states (a
 * payment the chain reverted is `failed` too); an owed intent with a payment recorded and not booked is `sending`; an owed
 * one with no payment is `owed`; anything else is `other`, named by its state.
 */

type Sql = postgres.Sql;

const BOARD_LIMIT = 200;

type Row = {
  reward_key: string;
  campaign_id: string;
  account_id: string;
  asset: string;
  amount: string;
  state: RewardState;
  reason: string | null;
  owe_tx_id: string | null;
  ledger_tx_id: string | null;
  updated_at: Date;
  pay_state: 'sending' | 'sent' | 'booked' | 'failed' | null;
  pay_to: string | null;
  pay_chain_tx: string | null;
  pay_sent_at: Date | null;
  pay_reason: string | null;
};

/** Where one intent stands on the board, from its own state and its payment's. */
export function boardStateOf(state: string, payment: Row['pay_state']): PayoutBoardState {
  if (state === 'paid') return 'paid';
  if (state === 'failed' || payment === 'failed') return 'failed';
  if (state === 'pending_funding') return 'pending_funding';
  if (state === 'owed') return payment === 'sending' || payment === 'sent' ? 'sending' : 'owed';
  return 'other';
}

/** The board's state, as SQL, for counting every intent (the same rules as `boardStateOf`). */
const BOARD_SQL = `CASE
  WHEN i.state = 'paid' THEN 'paid'
  WHEN i.state = 'failed' OR p.state = 'failed' THEN 'failed'
  WHEN i.state = 'pending_funding' THEN 'pending_funding'
  WHEN i.state = 'owed' AND p.state IN ('sending', 'sent') THEN 'sending'
  WHEN i.state = 'owed' THEN 'owed'
  ELSE 'other' END`;

export async function payoutBoard(sql: Sql, input: { campaignId?: string }, now: Date = new Date()): Promise<PayoutBoard> {
  const campaignId = input.campaignId ?? null;
  const [rows, counted] = await Promise.all([
    sql<Row[]>`
      SELECT i.reward_key, i.campaign_id, i.account_id, i.asset, i.amount::text AS amount, i.state, i.reason, i.owe_tx_id,
        i.ledger_tx_id, greatest(i.updated_at, coalesce(p.updated_at, i.updated_at)) AS updated_at,
        p.state AS pay_state, p.to_wallet AS pay_to, p.chain_tx AS pay_chain_tx, p.sent_at AS pay_sent_at, p.reason AS pay_reason
      FROM campaigns.reward_intents i LEFT JOIN campaigns.reward_payments p ON p.reward_key = i.reward_key
      WHERE ${campaignId}::text IS NULL OR i.campaign_id = ${campaignId}
      ORDER BY 10 DESC, i.reward_key LIMIT ${BOARD_LIMIT}`,
    sql<{ board: PayoutBoardState; n: number }[]>`
      SELECT ${sql.unsafe(BOARD_SQL)} AS board, count(*)::int AS n
      FROM campaigns.reward_intents i LEFT JOIN campaigns.reward_payments p ON p.reward_key = i.reward_key
      WHERE ${campaignId}::text IS NULL OR i.campaign_id = ${campaignId}
      GROUP BY 1`,
  ]);
  const attempts = await attemptsOf(
    sql,
    rows.map((r) => r.reward_key),
  );
  const counts = Object.fromEntries(PAYOUT_BOARD_STATES.map((s) => [s, 0])) as Record<PayoutBoardState, number>;
  for (const c of counted) counts[c.board] = c.n;
  return {
    counts,
    rows: rows.map((r): PayoutBoardRow => ({
      rewardKey: r.reward_key,
      campaignId: r.campaign_id,
      accountId: r.account_id,
      asset: r.asset,
      amount: formatAmount(parseAmount(r.amount)),
      board: boardStateOf(r.state, r.pay_state),
      state: r.state,
      reason: r.reason ?? r.pay_reason,
      owedTxId: r.owe_tx_id,
      paidTxId: r.state === 'paid' ? r.ledger_tx_id : null,
      payment:
        r.pay_state && r.pay_to && r.pay_sent_at
          ? {
              state: r.pay_state,
              toWallet: r.pay_to,
              chainTx: r.pay_chain_tx,
              sentAt: new Date(r.pay_sent_at).toISOString(),
              reason: r.pay_reason,
            }
          : null,
      attempts: attempts.get(r.reward_key) ?? [],
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    asOf: now.toISOString(),
  };
}

async function attemptsOf(sql: Sql, keys: string[]): Promise<Map<string, RedemptionAttempt[]>> {
  const out = new Map<string, RedemptionAttempt[]>();
  if (keys.length === 0) return out;
  const rows = await sql<{ reward_key: string; outcome: RedemptionAttempt['outcome']; reason: string | null; at: Date }[]>`
    SELECT reward_key, outcome, reason, at FROM campaigns.redemption_attempts WHERE reward_key IN ${sql(keys)} ORDER BY id`;
  for (const r of rows) {
    const list = out.get(r.reward_key) ?? [];
    list.push({ at: new Date(r.at).toISOString(), outcome: r.outcome, reason: r.reason });
    out.set(r.reward_key, list);
  }
  return out;
}
