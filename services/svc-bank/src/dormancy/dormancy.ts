import type { Sql } from 'postgres';
import { formatAmount, parseAmount, recipes, userAvailable, type LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { LedgerHistory } from '../analytics/ledger-history.js';

/**
 * THE DORMANCY FEE (RC-bank-01, J-bank-16 #7).
 *
 * The owner publishes a rule per coin (`BANK_DORMANCY_RULES_JSON`: fee, days with no activity, days of notice, version;
 * NO DEFAULT, blank refuses `bank.dormancy_rule_unset`). The run (`ops.runDormancy`, called by the bank's scheduler):
 *
 * 1. An account whose last ledger line in a coin is at least the rule's days old gets one notice, naming the fee and the
 *    debit date (`dormancy-notice:<user>:<asset>:<debitDate>`). Running again finds it and adds none.
 * 2. On the debit date the account is read again. A zero balance posts nothing (`skipped_zero`); any activity after the
 *    notice cancels it (`cancelled`); a balance below the fee posts nothing (`skipped_insufficient`: never part-charged,
 *    never overdrawn); otherwise `feeCharge` posts the noticed amount once (`fee:bank.dormancy:<user>:<asset>:<debitDate>`).
 *
 * Inactivity is read from the ledger history, never from a stored "last seen". A rule changed after a notice does not
 * change that notice: the debit is the amount noticed.
 */

export interface DormancyRule {
  readonly assetId: string;
  readonly fee: string;
  readonly inactiveDays: number;
  readonly noticeLeadDays: number;
  readonly version: string;
}

export type DormancyState = 'noticed' | 'cancelled' | 'skipped_zero' | 'skipped_insufficient' | 'charged';

export interface DormancyNotice {
  readonly assetId: string;
  readonly fee: string;
  readonly debitDate: string;
  readonly inactiveDays: number;
  readonly state: DormancyState;
  readonly ledgerTxId: string | null;
  readonly noticedAt: Date;
  readonly settledAt: Date | null;
}

export const DORMANCY_MODULE = 'bank.dormancy';
const DAY = 86_400_000;
const day = (at: Date) => at.toISOString().slice(0, 10);

/** The owner's dormancy rules, or null when blank or not in shape. */
export function parseDormancyRules(raw: string | undefined): DormancyRule[] | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const out: DormancyRule[] = [];
  for (const r of parsed as Array<Record<string, unknown>>) {
    if (typeof r.assetId !== 'string' || !/^[A-Z0-9]{2,16}$/.test(r.assetId)) return null;
    if (typeof r.fee !== 'string' || !/^\d+(\.\d{1,18})?$/.test(r.fee) || parseAmount(r.fee) <= 0n) return null;
    if (!Number.isInteger(r.inactiveDays) || (r.inactiveDays as number) < 1) return null;
    if (!Number.isInteger(r.noticeLeadDays) || (r.noticeLeadDays as number) < 1) return null;
    if (typeof r.version !== 'string' || !r.version.trim()) return null;
    out.push({
      assetId: r.assetId,
      fee: formatAmount(parseAmount(r.fee)),
      inactiveDays: r.inactiveDays as number,
      noticeLeadDays: r.noticeLeadDays as number,
      version: r.version,
    });
  }
  if (new Set(out.map((r) => r.assetId)).size !== out.length) return null;
  return out;
}

export class DormancyService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly history: LedgerHistory,
    private readonly rules: DormancyRule[] | null,
  ) {}

  published(): DormancyRule[] {
    if (!this.rules)
      throw new BankError('No dormancy rule is published, so no dormancy fee is noticed or taken', 'bank.dormancy_rule_unset');
    return this.rules;
  }

  /** The person's own notices, newest first. */
  async notices(userId: string): Promise<DormancyNotice[]> {
    const rows = await this.sql<
      Array<{
        asset_id: string;
        fee: string;
        debit_date: string;
        inactive_days: number;
        state: DormancyState;
        ledger_tx_id: string | null;
        noticed_at: Date;
        settled_at: Date | null;
      }>
    >`SELECT asset_id, fee::text AS fee, debit_date, inactive_days, state, ledger_tx_id, noticed_at, settled_at
        FROM bank.dormancy_notices WHERE user_id = ${userId} ORDER BY noticed_at DESC, asset_id`;
    return rows.map((r) => ({
      assetId: r.asset_id,
      fee: formatAmount(parseAmount(r.fee)),
      debitDate: r.debit_date,
      inactiveDays: Number(r.inactive_days),
      state: r.state,
      ledgerTxId: r.ledger_tx_id,
      noticedAt: r.noticed_at,
      settledAt: r.settled_at,
    }));
  }

  /**
   * The newest ledger line on the person's account in a coin, or null when the account never moved. A dormancy fee the
   * bank took is not the person's activity, so it does not end the quiet.
   */
  private async lastActivity(userId: string, assetId: string, to: Date): Promise<Date | null> {
    const entries = await this.history.entriesFor(userAvailable(userId, assetId), { from: new Date(0), to });
    return entries
      .filter((e) => e.module !== DORMANCY_MODULE)
      .reduce<Date | null>((last, e) => (last === null || e.postedAt > last ? e.postedAt : last), null);
  }

  /** One run of the job as of `at`, for the accounts named (the scheduler names every account it sweeps). */
  async run(input: { at: Date; userIds: readonly string[] }): Promise<{
    noticed: Array<{ userId: string; assetId: string; fee: string; debitDate: string }>;
    settled: Array<{ userId: string; assetId: string; debitDate: string; outcome: Exclude<DormancyState, 'noticed'> }>;
  }> {
    const rules = this.published();
    const noticed: Array<{ userId: string; assetId: string; fee: string; debitDate: string }> = [];
    const settled: Array<{ userId: string; assetId: string; debitDate: string; outcome: Exclude<DormancyState, 'noticed'> }> = [];
    for (const userId of input.userIds) {
      for (const rule of rules) {
        const [open] = await this.sql<Array<{ debit_date: string; fee: string; noticed_at: Date }>>`
          SELECT debit_date, fee::text AS fee, noticed_at FROM bank.dormancy_notices
           WHERE user_id = ${userId} AND asset_id = ${rule.assetId} AND state = 'noticed'`;
        if (open) {
          if (day(input.at) < open.debit_date) continue;
          const outcome = await this.settle(userId, rule.assetId, open);
          settled.push({ userId, assetId: rule.assetId, debitDate: open.debit_date, outcome });
          continue;
        }
        const last = await this.lastActivity(userId, rule.assetId, input.at);
        if (last === null) continue;
        // A new quiet period starts at the last notice's debit date too: one fee per period of the rule's days, not one
        // every notice lead.
        const [prior] = await this.sql<Array<{ debit_date: string }>>`
          SELECT max(debit_date) AS debit_date FROM bank.dormancy_notices
           WHERE user_id = ${userId} AND asset_id = ${rule.assetId} AND state <> 'noticed'`;
        const since = Math.max(last.getTime(), prior?.debit_date ? Date.parse(`${prior.debit_date}T00:00:00Z`) : 0);
        if (input.at.getTime() - since < rule.inactiveDays * DAY) continue;
        const debitDate = day(new Date(input.at.getTime() + rule.noticeLeadDays * DAY));
        const inserted = await this.sql`
          INSERT INTO bank.dormancy_notices (user_id, asset_id, debit_date, fee, inactive_days, rule_version, noticed_at)
          VALUES (${userId}, ${rule.assetId}, ${debitDate}, ${rule.fee}, ${rule.inactiveDays}, ${rule.version}, now())
          ON CONFLICT DO NOTHING
          RETURNING user_id`;
        if (inserted.length > 0) noticed.push({ userId, assetId: rule.assetId, fee: rule.fee, debitDate });
      }
    }
    return { noticed, settled };
  }

  private async settle(
    userId: string,
    assetId: string,
    open: { debit_date: string; fee: string; noticed_at: Date },
  ): Promise<Exclude<DormancyState, 'noticed'>> {
    const fee = parseAmount(open.fee);
    const balance = (await this.ledger.balance(userAvailable(userId, assetId))).amount;
    let outcome: Exclude<DormancyState, 'noticed'>;
    let txId: string | null = null;
    if (balance === 0n) outcome = 'skipped_zero';
    else if (((await this.lastActivity(userId, assetId, new Date(8.64e15))) ?? new Date(0)) > open.noticed_at) outcome = 'cancelled';
    else if (balance < fee) outcome = 'skipped_insufficient';
    else {
      const posted = await this.ledger.post(
        recipes.feeCharge({
          chargeId: `${userId}:${assetId}:${open.debit_date}`,
          userId,
          module: DORMANCY_MODULE,
          mode: 'asset',
          assetId,
          amount: fee,
        }),
      );
      outcome = 'charged';
      txId = posted.id;
    }
    await this.sql`
      UPDATE bank.dormancy_notices SET state = ${outcome}, ledger_tx_id = ${txId}, settled_at = now()
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND debit_date = ${open.debit_date} AND state = 'noticed'`;
    return outcome;
  }
}
