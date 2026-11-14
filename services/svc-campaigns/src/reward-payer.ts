import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { LedgerError, REWARD_ASSET, classifyPostOutcome, parseAmount, recipes, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { ledgerRewardId } from './payouts.js';

/**
 * Paying a reward INTAFACED owes to the customer's own wallet (launch money model, docs/adr/2026-11-10-launch-money-model.md
 * rule 5: Pay; J-campaigns-03 #2 #3; #8195). This is the only place svc-campaigns sends money on a chain, and it books
 * each payment only through `rewardPayOut`, keyed by the chain transaction that paid it.
 *
 * A reward is due once it is owed and its hold, if any, has ended with the account active (a `released` line). It is
 * paid to the wallet the customer had connected when they claimed it (`pay_to_wallet`), from our own-funds place (the
 * rewards wallet our collected builder fees are moved to), in the token's units. Before anything is sent:
 *
 * - the ledger's platform posting freeze is read (`postingEnabled` on svc-ledger's `/health`): while it is on nothing is
 *   sent and the reward stays owed with reason `ledger.frozen` (one `refused` line per change). Unread: nothing is sent;
 * - our wallet's balance of the token is read from the chain: less than the reward and it waits, owed, with reason
 *   `campaigns.reward_wallet_short`.
 *
 * One payment per reward (`reward_payments`, keyed by the reward): the row (where to, how much, the chain's head) is
 * written BEFORE the send, so a send that threw is looked up on the chain by those facts and never sent twice; a send the
 * chain never took (not found after `LOST_PAYMENT_AFTER_MS`) or a reverted one is `failed`, never sent again, and the
 * reward stays owed with that reason for a person. Once the receipt succeeds the payment is booked, and only the ledger's
 * answer makes the reward `paid`. A refused or lost booking leaves the payment `sent` and the reward owed with the reason;
 * the next pass books the same key again, so the ledger answers a booking that landed with its first transaction.
 */

type Sql = postgres.Sql;

export const WALLET_SHORT = 'campaigns.reward_wallet_short';
export const NO_WALLET = 'campaigns.no_connected_wallet';
export const PAYMENT_NOT_TAKEN = 'campaigns.reward_payment_not_taken';
export const PAYMENT_REVERTED = 'campaigns.reward_payment_reverted';
export const AMOUNT_UNPAYABLE = 'campaigns.reward_amount_unpayable';
export const FROZEN = 'ledger.frozen';

/** How long a send with no answer is looked for on the chain before it counts as never taken (the TEST chain mines at once). */
export const LOST_PAYMENT_AFTER_MS = 60_000;

/** What the payer needs from a chain: our wallet's token balance, one token transfer from it, and its receipt. */
export interface RewardChain {
  head(): Promise<bigint>;
  holds(from: string): Promise<bigint>;
  send(from: string, to: string, units: bigint): Promise<string>;
  /** `true` succeeded, `false` reverted, `null` not mined yet (or unread). */
  receipt(hash: string): Promise<boolean | null>;
  /** Every transfer of exactly `units` from `from` to `to` since `fromBlock`, oldest first. */
  find(from: string, to: string, units: bigint, fromBlock: bigint): Promise<readonly string[]>;
}

/** Our own-funds place rewards are paid from: its ledger id (`<chain>:<name>`) and its address on the chain. */
export interface RewardWallet {
  readonly walletId: string;
  readonly address: string;
  readonly tokenDecimals: number;
}

export interface RewardPayerOptions {
  sql: Sql;
  ledger: LedgerClient;
  chain: RewardChain;
  wallet: RewardWallet;
  /** True while the ledger takes posts, false while the platform posting freeze is on, null when it could not be read. */
  postingEnabled: () => Promise<boolean | null>;
  now?: () => Date;
}

type DueRow = { reward_key: string; campaign_id: string; amount: string; pay_to_wallet: string | null; reason: string | null };
type PaymentRow = {
  reward_key: string;
  campaign_id: string;
  to_wallet: string;
  amount: string;
  units: string;
  from_block: string;
  sent_at: Date;
  chain_tx: string | null;
  state: 'sending' | 'sent';
  reason: string | null;
};

/** A scaled amount in the token's base units, or null when the token can't carry it exactly (never rounded). */
export function unitsOf(amount: Amount, decimals: number): bigint | null {
  const scale = 10n ** BigInt(18 - decimals);
  return amount % scale === 0n ? amount / scale : null;
}

export class RewardPayer {
  private readonly sql: Sql;
  private readonly ledger: LedgerClient;
  private readonly chain: RewardChain;
  private readonly wallet: RewardWallet;
  private readonly postingEnabled: () => Promise<boolean | null>;
  private readonly now: () => Date;

  constructor(options: RewardPayerOptions) {
    this.sql = options.sql;
    this.ledger = options.ledger;
    this.chain = options.chain;
    this.wallet = { ...options.wallet, address: options.wallet.address.toLowerCase() };
    this.postingEnabled = options.postingEnabled;
    this.now = options.now ?? (() => new Date());
  }

  /** One pass: finish every payment already sent, then pay what is due, then finish those. */
  async pass(limit = 50): Promise<{ sent: number; paid: number }> {
    let paid = await this.settleOpen(limit);
    const sent = await this.payDue(limit);
    if (sent > 0) paid += await this.settleOpen(limit);
    return { sent, paid };
  }

  /** Owed, paid-form USDC rewards whose hold ended with the account active (or had none), with no payment yet. */
  private due(limit: number) {
    return this.sql<DueRow[]>`
      SELECT i.reward_key, i.campaign_id, i.amount::text AS amount, i.pay_to_wallet, i.reason
      FROM campaigns.reward_intents i
      WHERE i.state = 'owed' AND i.form = 'paid' AND i.asset = ${REWARD_ASSET}
        AND (i.reason IS NULL OR i.reason NOT LIKE 'account.%')
        AND (i.hold_until IS NULL
          OR EXISTS (SELECT 1 FROM campaigns.redemption_attempts a WHERE a.reward_key = i.reward_key AND a.outcome = 'released'))
        AND NOT EXISTS (SELECT 1 FROM campaigns.reward_payments p WHERE p.reward_key = i.reward_key)
      ORDER BY i.owed_at, i.reward_key LIMIT ${limit}`;
  }

  private async payDue(limit: number): Promise<number> {
    const due = await this.due(limit);
    if (due.length === 0) return 0;
    const posting = await this.postingEnabled();
    // Unread: nothing is sent and nothing is said; the next pass reads again.
    if (posting === null) return 0;
    if (!posting) {
      for (const r of due) await this.waitWith(r, FROZEN, 'refused');
      return 0;
    }
    let sent = 0;
    for (const r of due) {
      if (!r.pay_to_wallet) {
        await this.waitWith(r, NO_WALLET, null);
        continue;
      }
      const amount = parseAmount(r.amount);
      const units = unitsOf(amount, this.wallet.tokenDecimals);
      if (units === null || units <= 0n) {
        await this.waitWith(r, AMOUNT_UNPAYABLE, null);
        continue;
      }
      if ((await this.chain.holds(this.wallet.address)) < units) {
        await this.waitWith(r, WALLET_SHORT, null);
        continue;
      }
      const fromBlock = await this.chain.head();
      // Recorded before the send: a send that throws after the chain took it is found next pass, never sent again.
      const [made] = await this.sql<{ reward_key: string }[]>`
        INSERT INTO campaigns.reward_payments (reward_key, from_place, to_wallet, asset, amount, units, from_block, sent_at)
        VALUES (${r.reward_key}, ${this.wallet.walletId}, ${r.pay_to_wallet}, ${REWARD_ASSET}, ${r.amount}, ${units.toString()},
          ${fromBlock.toString()}, ${this.now()})
        ON CONFLICT (reward_key) DO NOTHING RETURNING reward_key`;
      if (!made) continue;
      sent += 1;
      let hash: string;
      try {
        hash = (await this.chain.send(this.wallet.address, r.pay_to_wallet, units)).toLowerCase();
      } catch {
        continue;
      }
      await this.sql`
        UPDATE campaigns.reward_payments SET chain_tx = ${hash}, updated_at = now()
        WHERE reward_key = ${r.reward_key} AND chain_tx IS NULL`;
    }
    return sent;
  }

  /** Keeps a due reward owed with the reason it waits; a log line only when the reason changes and `outcome` is given. */
  private async waitWith(r: DueRow, reason: string, outcome: 'refused' | null): Promise<void> {
    if (r.reason === reason) return;
    await transaction(this.sql, async (tx) => {
      const changed = await tx`
        UPDATE campaigns.reward_intents SET reason = ${reason}, updated_at = now()
        WHERE reward_key = ${r.reward_key} AND state = 'owed' AND reason IS NOT DISTINCT FROM ${r.reason}`;
      if (changed.count > 0 && outcome) {
        await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${r.reward_key}, ${outcome}, ${reason})`;
      }
    });
  }

  private async settleOpen(limit: number): Promise<number> {
    const open = await this.sql<PaymentRow[]>`
      SELECT p.reward_key, i.campaign_id, p.to_wallet, p.amount::text AS amount, p.units::text AS units,
        p.from_block::text AS from_block, p.sent_at, p.chain_tx, p.state, i.reason
      FROM campaigns.reward_payments p JOIN campaigns.reward_intents i ON i.reward_key = p.reward_key
      WHERE p.state IN ('sending', 'sent') ORDER BY p.created_at LIMIT ${limit}`;
    let paid = 0;
    for (const p of open) {
      try {
        if (await this.settle(p)) paid += 1;
      } catch {
        // A chain read that failed: this payment is looked at again next pass, the others still are.
      }
    }
    return paid;
  }

  private async settle(p: PaymentRow): Promise<boolean> {
    let hash = p.chain_tx;
    if (p.state === 'sending') {
      if (hash === null) {
        const units = BigInt(p.units);
        const taken = await this.sql<{ chain_tx: string }[]>`
          SELECT chain_tx FROM campaigns.reward_payments WHERE chain_tx IS NOT NULL`;
        const claimed = new Set(taken.map((t) => t.chain_tx));
        const found = (await this.chain.find(this.wallet.address, p.to_wallet, units, BigInt(p.from_block)))
          .map((h) => h.toLowerCase())
          .find((h) => !claimed.has(h));
        if (found === undefined) {
          if (this.now().getTime() - p.sent_at.getTime() < LOST_PAYMENT_AFTER_MS) return false;
          await this.fail(p, PAYMENT_NOT_TAKEN);
          return false;
        }
        hash = found;
        await this.sql`UPDATE campaigns.reward_payments SET chain_tx = ${hash}, updated_at = now() WHERE reward_key = ${p.reward_key}`;
      }
      const ok = await this.chain.receipt(hash);
      if (ok === null) return false;
      if (!ok) {
        await this.fail(p, PAYMENT_REVERTED);
        return false;
      }
      await this.sql`UPDATE campaigns.reward_payments SET state = 'sent', updated_at = now() WHERE reward_key = ${p.reward_key}`;
    }
    return this.book(p, hash!);
  }

  /** Never sent again: the reward stays owed with the reason, for a person to look at. */
  private async fail(p: PaymentRow, reason: string): Promise<void> {
    await transaction(this.sql, async (tx) => {
      const moved = await tx`
        UPDATE campaigns.reward_payments SET state = 'failed', reason = ${reason}, updated_at = now()
        WHERE reward_key = ${p.reward_key} AND state = 'sending'`;
      if (moved.count === 0) return;
      await tx`UPDATE campaigns.reward_intents SET reason = ${reason}, updated_at = now() WHERE reward_key = ${p.reward_key} AND state = 'owed'`;
      await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason) VALUES (${p.reward_key}, 'refused', ${reason})`;
    });
  }

  /** Books a payment the chain confirmed; only the ledger's answer makes the reward paid. */
  private async book(p: PaymentRow, chainTx: string): Promise<boolean> {
    let txId: string;
    try {
      const tx = await this.ledger.post(
        recipes.rewardPayOut({
          rewardId: ledgerRewardId(p.campaign_id, p.reward_key),
          from: { kind: 'treasury-wallet', walletId: this.wallet.walletId },
          toWallet: p.to_wallet,
          chainTx,
          assetId: REWARD_ASSET,
          amount: parseAmount(p.amount),
        }),
      );
      txId = tx.id;
    } catch (err) {
      if (process.env.DEBUG_PAYER) console.error('book failed', err);
      const reason = err instanceof LedgerError ? err.code : 'ledger.answer_lost';
      const refused = err instanceof LedgerError && classifyPostOutcome(err) === 'refused';
      if (p.reason !== reason) {
        await transaction(this.sql, async (tx) => {
          const changed = await tx`
            UPDATE campaigns.reward_intents SET reason = ${reason}, updated_at = now()
            WHERE reward_key = ${p.reward_key} AND state = 'owed' AND reason IS NOT DISTINCT FROM ${p.reason}`;
          if (changed.count > 0) {
            await tx`
              INSERT INTO campaigns.redemption_attempts (reward_key, outcome, reason)
              VALUES (${p.reward_key}, ${refused ? 'refused' : 'unknown'}, ${reason})`;
          }
        });
      }
      return false;
    }
    return transaction(this.sql, async (tx) => {
      await tx`
        UPDATE campaigns.reward_payments SET state = 'booked', paid_tx_id = ${txId}, reason = NULL, updated_at = now()
        WHERE reward_key = ${p.reward_key} AND state = 'sent'`;
      const paid = await tx`
        UPDATE campaigns.reward_intents SET state = 'paid', ledger_tx_id = ${txId}, paid_at = now(), paid_chain_tx = ${chainTx},
          reason = NULL, updated_at = now()
        WHERE reward_key = ${p.reward_key} AND state = 'owed' AND pay_to_wallet = ${p.to_wallet}`;
      if (paid.count === 0) return false;
      await tx`INSERT INTO campaigns.redemption_attempts (reward_key, outcome) VALUES (${p.reward_key}, 'paid')`;
      return true;
    });
  }
}
