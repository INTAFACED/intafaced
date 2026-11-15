import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { partnerFigure, partnerFeesAccount, type PartnerBank, type PartnerCustody } from '../partner/partner-bank.js';
import { partnerMovesBetween } from '../partner/partner-history.js';
import { BankError } from '../errors.js';

/**
 * THE DORMANCY FEE (RC-bank-01, J-bank-16 #7).
 *
 * The owner publishes a rule per coin (`BANK_DORMANCY_RULES_JSON`: fee, days with no activity, days of notice, version;
 * NO DEFAULT, blank refuses `bank.dormancy_rule_unset`). The run (`ops.runDormancy`, called by the bank's scheduler):
 *
 * 1. An account whose last line at the partner in a coin is at least the rule's days old gets one notice, naming the fee
 *    and the debit date (`dormancy-notice:<user>:<asset>:<debitDate>`). Running again finds it and adds none.
 * 2. On the debit date the partner's figure is read again. Zero takes nothing (`skipped_zero`); any activity after the
 *    notice cancels it (`cancelled`); below the fee takes nothing (`skipped_insufficient`: never part-charged); otherwise
 *    the partner carries out one move of the noticed amount under `fee:bank.dormancy:<user>:<asset>:<debitDate>`.
 *
 * The partner holds the money, so nothing here posts to our ledger (launch money model, rules 1 to 3). A person the
 * partner does not hold money for is on the custodial layer, which charges no dormancy fee, and is passed over.
 * Activity is read from the partner's record, never a stored "last seen". A figure the partner has not given, or gave
 * too long ago, decides nothing: no notice, and an open notice waits for the next run. A rule changed after a notice
 * does not change that notice: the debit is the amount noticed.
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
  /** The partner's reference for the fee it took; null when none was taken. */
  readonly partnerMoveId: string | null;
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
    private readonly custody: PartnerCustody,
    private readonly rules: DormancyRule[] | null,
    private readonly clock: () => Date = () => new Date(),
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
        partner_move_id: string | null;
        noticed_at: Date;
        settled_at: Date | null;
      }>
    >`SELECT asset_id, fee::text AS fee, debit_date, inactive_days, state, partner_move_id, noticed_at, settled_at
        FROM bank.dormancy_notices WHERE user_id = ${userId} ORDER BY noticed_at DESC, asset_id`;
    return rows.map((r) => ({
      assetId: r.asset_id,
      fee: formatAmount(parseAmount(r.fee)),
      debitDate: r.debit_date,
      inactiveDays: Number(r.inactive_days),
      state: r.state,
      partnerMoveId: r.partner_move_id,
      noticedAt: r.noticed_at,
      settledAt: r.settled_at,
    }));
  }

  /** Whether the person's account in a coin moved in a window. A dormancy fee the partner took is not their activity. */
  private async movedBetween(partner: PartnerBank, userId: string, assetId: string, from: Date, to: Date): Promise<boolean> {
    if (to <= from) return false;
    const moves = await partnerMovesBetween(partner, userId, { assetId, from, to });
    return moves.some((m) => !m.key.startsWith(`fee:${DORMANCY_MODULE}:`));
  }

  private chargeKey(userId: string, assetId: string, debitDate: string): string {
    return `fee:${DORMANCY_MODULE}:${userId}:${assetId}:${debitDate}`;
  }

  /** The partner's figure for the person's main balance, or null when it is not known or too old to decide on. */
  private async mainBalance(partner: PartnerBank, userId: string, assetId: string): Promise<bigint | null> {
    const balance = await partner.balance({ userId, assetId, spaceId: null });
    const figure = partnerFigure(balance, partner.staleAfterMs, this.clock());
    return figure.state === 'known' ? parseAmount(figure.amount) : null;
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
      const partner = this.custody.bankFor(userId);
      if (!partner) continue;
      for (const rule of rules) {
        const [open] = await this.sql<Array<{ debit_date: string; fee: string; noticed_at: Date }>>`
          SELECT debit_date, fee::text AS fee, noticed_at FROM bank.dormancy_notices
           WHERE user_id = ${userId} AND asset_id = ${rule.assetId} AND state = 'noticed'`;
        if (open) {
          if (day(input.at) < open.debit_date) continue;
          const outcome = await this.settle(partner, userId, rule.assetId, open, input.at);
          if (outcome) settled.push({ userId, assetId: rule.assetId, debitDate: open.debit_date, outcome });
          continue;
        }
        // Quiet means no activity in the rule's days before `at`. A new quiet period also starts at the last notice's debit
        // date: one fee per period of the rule's days, not one every notice lead.
        const windowStart = new Date(input.at.getTime() - rule.inactiveDays * DAY);
        const [prior] = await this.sql<Array<{ debit_date: string | null }>>`
          SELECT max(debit_date) AS debit_date FROM bank.dormancy_notices
           WHERE user_id = ${userId} AND asset_id = ${rule.assetId} AND state <> 'noticed'`;
        if (prior?.debit_date && Date.parse(`${prior.debit_date}T00:00:00Z`) > windowStart.getTime()) continue;
        if (await this.movedBetween(partner, userId, rule.assetId, windowStart, input.at)) continue;
        // A notice names a fee that can be taken: an account holding less than the fee (or nothing) is not told one will be.
        const balance = await this.mainBalance(partner, userId, rule.assetId);
        if (balance === null || balance < parseAmount(rule.fee)) continue;
        const debitDate = day(new Date(input.at.getTime() + rule.noticeLeadDays * DAY));
        const inserted = await this.sql`
          INSERT INTO bank.dormancy_notices (user_id, asset_id, debit_date, fee, inactive_days, rule_version, noticed_at)
          VALUES (${userId}, ${rule.assetId}, ${debitDate}, ${rule.fee}, ${rule.inactiveDays}, ${rule.version}, ${input.at})
          ON CONFLICT DO NOTHING
          RETURNING user_id`;
        if (inserted.length > 0) noticed.push({ userId, assetId: rule.assetId, fee: rule.fee, debitDate });
      }
    }
    return { noticed, settled };
  }

  /** Settles one notice whose date has come, or returns null to leave it open while the partner's figure is not known. */
  private async settle(
    partner: PartnerBank,
    userId: string,
    assetId: string,
    open: { debit_date: string; fee: string; noticed_at: Date },
    at: Date,
  ): Promise<Exclude<DormancyState, 'noticed'> | null> {
    const fee = parseAmount(open.fee);
    const key = this.chargeKey(userId, assetId, open.debit_date);
    let outcome: Exclude<DormancyState, 'noticed'>;
    let moveId: string | null = null;
    // A fee the partner already took under this notice's key (a crash after the move, before the row was settled) is
    // adopted, never re-judged from a balance it already lowered.
    const taken = await partner.moveByKey(key);
    if (taken) {
      outcome = 'charged';
      moveId = taken.id;
    } else {
      const balance = await this.mainBalance(partner, userId, assetId);
      if (balance === null) return null;
      if (balance === 0n) outcome = 'skipped_zero';
      else if (await this.movedBetween(partner, userId, assetId, open.noticed_at, at)) outcome = 'cancelled';
      else if (balance < fee) outcome = 'skipped_insufficient';
      else {
        try {
          const move = await partner.move({ key, from: { userId, assetId, spaceId: null }, to: partnerFeesAccount(assetId), amount: fee });
          outcome = 'charged';
          moveId = move.id;
        } catch (err) {
          // The partner refused before anything moved. Any other answer (a lost reply) throws: the next run asks by the key.
          if (!(err instanceof BankError) || err.code !== 'bank.partner_insufficient_funds') throw err;
          outcome = 'skipped_insufficient';
        }
      }
    }
    await this.sql`
      UPDATE bank.dormancy_notices SET state = ${outcome}, partner_move_id = ${moveId}, settled_at = now()
       WHERE user_id = ${userId} AND asset_id = ${assetId} AND debit_date = ${open.debit_date} AND state = 'noticed'`;
    return outcome;
  }
}
