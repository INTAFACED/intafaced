/**
 * PAY YOURSELF FROM YOUR TRADING (J-bank-31).
 *
 * A move is ONE venue withdrawal, signed once in the person's own wallet, from their venue account to their own account
 * at the partner bank (its pay-in, `test-pay-in.ts` on the TEST stack). The venue holds the money until it pays the
 * withdrawal, the partner from when it credits it; INTAFACED holds none of it and the ledger posts nothing. What is kept
 * here is only what the person asked for:
 *
 *   · `summary`: what their trading realised since their last move, as the venue reports it (svc-trade's read of the
 *     venue's closing fills, never a figure of ours), the partner's pay-in route and fee ("not known" when it gives none),
 *     their moves, the partner's pay-ins, their rule and any move it prepared;
 *   · `record`: a move the person signed and the venue took, by its business key and the venue's nonce, once;
 *   · `setRule`: one weekly rule, "on <weekday>, the week's realised profit, up to <cap>";
 *   · `runDue`: each rule whose day has come prepares ONE move for the profit realised since it last ran (less what the
 *     person already paid themselves in that time), up to its cap, waiting for their one signature. A week with no
 *     profit prepares nothing. A prepared move moves nothing: only the person's signature sends the withdrawal.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { add, compare, formatAmount, min, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { RealisedSource } from './realised-source.js';
import { PAY_IN_ASSET, type PayInCredit, type PayInRail, type PayInRoute } from './test-pay-in.js';

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const MOVE_KEY = /^pay-yourself:[A-Za-z0-9:._-]{1,140}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
/** Profit is counted from here for a person who has never paid themselves: before any venue fill. */
const BEGINNING = new Date('2020-01-01T00:00:00.000Z');

export interface PayYourselfMove {
  readonly id: string;
  readonly moveKey: string;
  readonly source: 'manual' | 'rule';
  readonly assetId: string;
  readonly amount: Amount;
  readonly status: 'prepared' | 'sent';
  readonly owner: string | null;
  readonly venueNonce: string | null;
  readonly windowFrom: Date | null;
  readonly windowTo: Date | null;
  readonly preparedAt: Date;
  readonly sentAt: Date | null;
}

export interface PayYourselfRule {
  readonly id: string;
  readonly weekday: Weekday;
  readonly assetId: string;
  readonly cap: Amount;
  readonly createdAt: Date;
  readonly lastRunAt: Date | null;
  readonly nextRunAt: Date;
}

export interface PayYourselfSummary {
  /** The partner's pay-in for this person, or the refusal code when none is wired. */
  readonly payIn: PayInRoute | { readonly unset: string };
  /** The partner's fee for a pay-in, or null when it does not say ("not known", never 0). */
  readonly partnerFee: Amount | null;
  /** Realised since the last move, as the venue reports it; `unread` with its code when it could not be read. */
  readonly realised:
    { readonly since: Date; readonly asOf: Date; readonly amount: Amount; readonly owner: string | null } | { readonly unread: string };
  readonly moves: readonly PayYourselfMove[];
  readonly credits: readonly PayInCredit[];
  readonly rule: PayYourselfRule | null;
}

type MoveRow = {
  id: string;
  move_key: string;
  source: 'manual' | 'rule';
  asset_id: string;
  amount: string;
  status: 'prepared' | 'sent';
  owner: string | null;
  venue_nonce: string | null;
  window_from: Date | null;
  window_to: Date | null;
  prepared_at: Date;
  sent_at: Date | null;
};
type RuleRow = {
  id: string;
  user_id: string;
  weekday: number;
  asset_id: string;
  cap: string;
  created_at: Date;
  last_run_at: Date | null;
  next_run_at: Date;
};

const MOVE_COLS = `id, move_key, source, asset_id, amount::text AS amount, status, owner, venue_nonce, window_from, window_to,
  prepared_at, sent_at`;
const RULE_COLS = `id, user_id, weekday, asset_id, cap::text AS cap, created_at, last_run_at, next_run_at`;

function moveOf(r: MoveRow): PayYourselfMove {
  return {
    id: r.id,
    moveKey: r.move_key,
    source: r.source,
    assetId: r.asset_id,
    amount: parseAmount(r.amount),
    status: r.status,
    owner: r.owner,
    venueNonce: r.venue_nonce,
    windowFrom: r.window_from,
    windowTo: r.window_to,
    preparedAt: r.prepared_at,
    sentAt: r.sent_at,
  };
}

function ruleOf(r: RuleRow): PayYourselfRule {
  return {
    id: r.id,
    weekday: WEEKDAYS[r.weekday - 1]!,
    assetId: r.asset_id,
    cap: parseAmount(r.cap),
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
  };
}

/** The start (00:00 UTC) of the next `weekday` strictly after `now`. */
export function nextWeekday(weekday: Weekday, now: Date): Date {
  const iso = WEEKDAYS.indexOf(weekday) + 1; // 1 Monday … 7 Sunday
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const today = ((day.getUTCDay() + 6) % 7) + 1;
  let ahead = (iso - today + 7) % 7;
  if (ahead === 0) ahead = 7;
  return new Date(day.getTime() + ahead * 86_400_000);
}

function unset(): BankError {
  return new BankError(
    'No partner pay-in a venue can withdraw to is wired, so nothing can be paid to the partner account.',
    'bank.pay_in_unset',
  );
}

export class PayYourselfService {
  constructor(
    private readonly sql: Sql,
    private readonly options: {
      readonly payIn: PayInRail | null;
      readonly realised: RealisedSource | null;
      /** The partner's pay-in fee for this person, or null when it does not say. */
      readonly partnerFee: (userId: string) => Amount | null;
      readonly now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  async moves(userId: string): Promise<PayYourselfMove[]> {
    const rows = await this.sql.unsafe<MoveRow[]>(
      `SELECT ${MOVE_COLS} FROM bank.pay_yourself_moves WHERE user_id = $1 ORDER BY prepared_at DESC, id LIMIT 50`,
      [userId],
    );
    return rows.map(moveOf);
  }

  async rule(userId: string): Promise<PayYourselfRule | null> {
    const rows = await this.sql.unsafe<RuleRow[]>(`SELECT ${RULE_COLS} FROM bank.pay_yourself_rules WHERE user_id = $1`, [userId]);
    return rows[0] ? ruleOf(rows[0]) : null;
  }

  /** What the person's trading realised from `since` to now, and from which main venue account; never 0 on a failed read. */
  private async realisedSince(userId: string, since: Date, until?: Date) {
    if (!this.options.realised) return { unread: 'bank.realised_unread' } as const;
    const read = await this.options.realised.realised(userId, PAY_IN_ASSET, since, until);
    if ('unread' in read) return read;
    // The account the most was realised on is the one a move withdraws from.
    const best = [...read.accounts].sort((a, b) => compare(b.realised, a.realised))[0] ?? null;
    return { since, asOf: read.asOf, amount: read.realised, owner: best?.owner ?? null };
  }

  async summary(userId: string): Promise<PayYourselfSummary> {
    const moves = await this.moves(userId);
    const lastSent = moves.find((m) => m.status === 'sent');
    const since = lastSent?.sentAt ?? BEGINNING;
    return {
      payIn: this.options.payIn ? this.options.payIn.route(userId) : { unset: 'bank.pay_in_unset' },
      partnerFee: this.options.partnerFee(userId),
      realised: await this.realisedSince(userId, since),
      moves,
      credits: this.options.payIn ? this.options.payIn.credits(userId) : [],
      rule: await this.rule(userId),
    };
  }

  /**
   * A move the person signed and the venue took: its business key, the venue account's owner, the venue's nonce and the
   * amount. Once per key: the same facts again answer the same move; other facts under the key refuse
   * `bank.pay_yourself_conflict`. A key a rule prepared marks that move sent, for the amount it prepared only.
   */
  async record(userId: string, input: { moveKey: string; owner: string; nonce: string; amount: Amount }): Promise<PayYourselfMove> {
    if (!this.options.payIn) throw unset();
    const owner = input.owner.toLowerCase();
    if (!MOVE_KEY.test(input.moveKey) || !ADDRESS.test(owner) || !/^[A-Za-z0-9:_-]{1,80}$/.test(input.nonce) || input.amount <= 0n) {
      throw new BankError(
        'A pay yourself move needs its key, the venue account’s owner, the venue’s nonce and an amount.',
        'bank.validation_failed',
      );
    }
    const conflict = () =>
      new BankError(`A different move is already recorded under ${input.moveKey}, so this one was not.`, 'bank.pay_yourself_conflict');
    return this.sql.begin(async (tx) => {
      const prior = (
        await tx.unsafe<(MoveRow & { user_id: string })[]>(
          `SELECT ${MOVE_COLS}, user_id FROM bank.pay_yourself_moves WHERE move_key = $1 FOR UPDATE`,
          [input.moveKey],
        )
      )[0];
      if (prior) {
        if (prior.user_id !== userId) throw conflict();
        const move = moveOf(prior);
        if (move.amount !== input.amount) throw conflict();
        if (move.status === 'sent') {
          if (move.owner !== owner || move.venueNonce !== input.nonce) throw conflict();
          return move;
        }
        const rows = await tx.unsafe<MoveRow[]>(
          `UPDATE bank.pay_yourself_moves SET status = 'sent', owner = $2, venue_nonce = $3, sent_at = $4
           WHERE id = $1 RETURNING ${MOVE_COLS}`,
          [move.id, owner, input.nonce, this.now()],
        );
        return moveOf(rows[0]!);
      }
      if (!input.moveKey.startsWith('pay-yourself:manual:')) {
        throw new BankError('No prepared move is held under that key.', 'bank.pay_yourself_move_not_found');
      }
      const rows = await tx.unsafe<MoveRow[]>(
        `INSERT INTO bank.pay_yourself_moves (id, user_id, move_key, source, asset_id, amount, status, owner, venue_nonce, prepared_at, sent_at)
         VALUES ($1, $2, $3, 'manual', $4, $5::numeric, 'sent', $6, $7, $8, $8) RETURNING ${MOVE_COLS}`,
        [randomUUID(), userId, input.moveKey, PAY_IN_ASSET, formatAmount(input.amount), owner, input.nonce, this.now()],
      );
      return moveOf(rows[0]!);
    });
  }

  /** The person's weekly rule, set or changed: from now, it runs at the start of the next `weekday` (UTC). */
  async setRule(userId: string, input: { weekday: Weekday; cap: Amount }): Promise<PayYourselfRule> {
    if (!this.options.payIn) throw unset();
    if (input.cap <= 0n) throw new BankError('A weekly rule needs a most it may move above zero.', 'bank.validation_failed');
    const now = this.now();
    const weekday = WEEKDAYS.indexOf(input.weekday) + 1;
    const rows = await this.sql.unsafe<RuleRow[]>(
      `INSERT INTO bank.pay_yourself_rules (id, user_id, weekday, asset_id, cap, created_at, next_run_at)
       VALUES ($1, $2, $3, $4, $5::numeric, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET weekday = EXCLUDED.weekday, cap = EXCLUDED.cap, next_run_at = EXCLUDED.next_run_at
       RETURNING ${RULE_COLS}`,
      [randomUUID(), userId, weekday, PAY_IN_ASSET, formatAmount(input.cap), now, nextWeekday(input.weekday, now)],
    );
    return ruleOf(rows[0]!);
  }

  /**
   * Every rule whose day has come, once each: the profit realised since the rule last ran (or was set), less what the
   * person paid themselves in that time, up to the cap, prepared as ONE move waiting for their signature, under
   * `pay-yourself:rule:<rule>:<window end>`. Nothing above zero, or a read that failed, prepares nothing; a failed read
   * leaves the rule due, so the next pass tries again. Nothing is sent: only the person's signature sends a withdrawal.
   */
  async runDue(input: { limit: number }): Promise<{ prepared: number; nothing: number; unread: number }> {
    const now = this.now();
    const due = await this.sql.unsafe<RuleRow[]>(
      `SELECT ${RULE_COLS} FROM bank.pay_yourself_rules WHERE next_run_at <= $1 ORDER BY next_run_at, id LIMIT $2`,
      [now, input.limit],
    );
    const out = { prepared: 0, nothing: 0, unread: 0 };
    for (const row of due) {
      const rule = ruleOf(row);
      const from = rule.lastRunAt ?? rule.createdAt;
      const read = await this.realisedSince(row.user_id, from, now);
      if ('unread' in read) {
        out.unread += 1;
        continue;
      }
      const paid = (await this.moves(row.user_id))
        .filter((m) => m.status === 'sent' && m.sentAt && m.sentAt >= from && m.sentAt < now)
        .reduce((sum, m) => add(sum, m.amount), ZERO);
      const amount = min(rule.cap, sub(read.amount, paid));
      await this.sql.begin(async (tx) => {
        if (amount > 0n) {
          await tx.unsafe(
            `INSERT INTO bank.pay_yourself_moves (id, user_id, move_key, source, rule_id, asset_id, amount, status, owner, window_from, window_to, prepared_at)
             VALUES ($1, $2, $3, 'rule', $4, $5, $6::numeric, 'prepared', $7, $8, $9, $9)
             ON CONFLICT (move_key) DO NOTHING`,
            [
              randomUUID(),
              row.user_id,
              `pay-yourself:rule:${rule.id}:${now.getTime()}`,
              rule.id,
              rule.assetId,
              formatAmount(amount),
              read.owner,
              from,
              now,
            ],
          );
        }
        await tx.unsafe(`UPDATE bank.pay_yourself_rules SET last_run_at = $2, next_run_at = $3 WHERE id = $1`, [
          rule.id,
          now,
          nextWeekday(rule.weekday, now),
        ]);
      });
      if (amount > 0n) out.prepared += 1;
      else out.nothing += 1;
    }
    return out;
  }
}
