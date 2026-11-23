import type { Sql, TransactionSql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import type { AccountDetailsService, CurrencyDetails } from '../account-details/account-details.js';
import {
  partnerPayoutsAccount,
  type PartnerAccountRef,
  type PartnerBank,
  type PartnerCustody,
  type PartnerMove,
} from '../partner/partner-bank.js';
import { testPartnerDetailsOwner } from '../partner/test-partner.js';
import { legShare, type IncomeSorterService } from '../sorter/income-sorter.js';
import { PAYROLL_SIM_RAIL, type PayrollCredit, type PayrollPartner } from './payroll-sim.js';

/**
 * SALARY PAID IN BY DIRECT DEPOSIT (J-bank-30; BK-salary-01, -02, -03).
 *
 * At launch the money is the partner bank's (OWNER 226): the employer pays the account details the partner issued, the
 * partner credits the person's main balance, and INTAFACED's ledger posts nothing. This service records what the payroll
 * network sent, keyed by the network's own id, and asks the partner for each move under a business key, reading each back
 * once:
 *
 *   - a credit is ONE pay-in at the partner, `salary:credit:<networkId>`. The same network id again changes nothing.
 *   - a credit naming an account holder other than the one the partner holds the account in is returned: nothing is
 *     credited and the row reads `bank.direct_deposit_name_mismatch`.
 *   - the person's split is their income sorter for that currency (BK-pots-03), fixed per credit when it arrives and sent
 *     to the partner once: each leg ONE partner move from the main balance into a space, `salary:split:<networkId>:<n>`.
 *   - a reversal inside the owner's window first moves the split legs back (`salary:unsplit:<networkId>:<n>`), then ONE
 *     partner move of the whole credit out to the partner's outbound account, `salary:reverse:<networkId>`. A main balance
 *     that no longer holds the credit refuses `bank.direct_deposit_reversal_insufficient`; outside the window it refuses
 *     `bank.direct_deposit_reversal_window`.
 *
 * Saga: the intent row is written on the network id before the partner is asked; an unknown answer leaves it pending, and
 * the network's retry under the same id finishes it under the same keys, so nothing moves twice.
 */

export type SalaryCreditState = 'pending' | 'received' | 'returned' | 'reversed';
export type SalaryLegStatus = 'pending' | 'settled' | 'rejected' | 'unsplit';

export interface SalaryLeg {
  readonly position: number;
  readonly spaceId: string;
  readonly amount: Amount;
  readonly status: SalaryLegStatus;
  readonly moveId: string | null;
  readonly rejectionCode: string | null;
  readonly unsplitMoveId: string | null;
}

export interface SalaryCredit {
  readonly networkId: string;
  readonly userId: string;
  readonly assetId: string;
  readonly amount: Amount;
  readonly originatorName: string;
  readonly state: SalaryCreditState;
  readonly refusalCode: string | null;
  readonly creditMoveId: string | null;
  readonly reversalMoveId: string | null;
  readonly createdAt: Date;
  readonly receivedAt: Date | null;
  readonly reversedAt: Date | null;
  readonly legs: readonly SalaryLeg[];
}

export interface SalaryDetails {
  /** Who the details and the money are with, e.g. "TEST partner bank". */
  readonly partnerBank: string;
  /** The network the employer pays over, e.g. the TEST payroll stand-in. */
  readonly network: string;
  /** The name the partner holds the account in; null when it has not given one ("not known"). */
  readonly holderName: string | null;
  readonly currencies: readonly CurrencyDetails[];
}

export interface SalaryForm {
  readonly currency: string;
  readonly holderName: string;
  readonly partnerBank: string;
  readonly accountNumber: string | null;
  readonly sortCode: string | null;
  readonly routingNumber: string | null;
  readonly iban: string | null;
  readonly bic: string | null;
  readonly reference: string;
  /** The same fields as plain text, for the person to download and hand to their employer. */
  readonly text: string;
}

export interface SalaryRailLine {
  readonly currency: string;
  /** The network's own word: what it credited and what was reversed. null when it keeps no record ("not known"). */
  readonly network: { readonly credits: Amount; readonly reversals: Amount } | null;
  /** What the app showed: credits read back from the partner, and reversals read back. */
  readonly app: { readonly credits: Amount; readonly reversals: Amount };
  /** null when the network's figure is not known. */
  readonly matches: boolean | null;
  /** network net minus app net; null when not known. */
  readonly difference: Amount | null;
}

export interface SalaryRails {
  readonly label: string;
  readonly asOf: Date;
  readonly lines: readonly SalaryRailLine[];
}

interface CreditRow {
  network_id: string;
  user_id: string;
  account_details_id: string;
  asset_id: string;
  amount: string;
  originator_name: string;
  holder_name: string;
  state: SalaryCreditState;
  refusal_code: string | null;
  credit_move_id: string | null;
  reversal_move_id: string | null;
  created_at: Date;
  received_at: Date | null;
  reversed_at: Date | null;
}

interface LegRow {
  network_id: string;
  position: number;
  space_id: string;
  amount: string;
  status: SalaryLegStatus;
  move_id: string | null;
  rejection_code: string | null;
  unsplit_move_id: string | null;
}

const CREDIT_COLS = `network_id, user_id, account_details_id, asset_id, amount::text AS amount, originator_name, holder_name,
  state, refusal_code, credit_move_id, reversal_move_id, created_at, received_at, reversed_at`;
const LEG_COLS = `network_id, position, space_id, amount::text AS amount, status, move_id, rejection_code, unsplit_move_id`;

export const creditKey = (networkId: string) => `salary:credit:${networkId}`;
export const splitKey = (networkId: string, position: number) => `salary:split:${networkId}:${position}`;
export const unsplitKey = (networkId: string, position: number) => `salary:unsplit:${networkId}:${position}`;
export const reverseKey = (networkId: string) => `salary:reverse:${networkId}`;

/** A name as a bank compares it: case, spacing and surrounding blanks do not count. */
export function holderNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The owner's reversal window in whole days, or null when unpublished or not 1 to 3650. */
export function parseReversalDays(raw: string | undefined): number | null {
  const value = raw?.trim() ?? '';
  if (!/^\d{1,4}$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= 3650 ? days : null;
}

function toLeg(row: LegRow): SalaryLeg {
  return {
    position: row.position,
    spaceId: row.space_id,
    amount: parseAmount(row.amount),
    status: row.status,
    moveId: row.move_id,
    rejectionCode: row.rejection_code,
    unsplitMoveId: row.unsplit_move_id,
  };
}

function toCredit(row: CreditRow, legs: LegRow[]): SalaryCredit {
  return {
    networkId: row.network_id,
    userId: row.user_id,
    assetId: row.asset_id,
    amount: parseAmount(row.amount),
    originatorName: row.originator_name,
    state: row.state,
    refusalCode: row.refusal_code,
    creditMoveId: row.credit_move_id,
    reversalMoveId: row.reversal_move_id,
    createdAt: row.created_at,
    receivedAt: row.received_at,
    reversedAt: row.reversed_at,
    legs: legs
      .filter((leg) => leg.network_id === row.network_id)
      .sort((a, b) => a.position - b.position)
      .map(toLeg),
  };
}

function railBank(): BankError {
  return new BankError('Salary paid in by direct deposit needs rail.bank. It is switched off in this build.', 'rail.bank');
}

/** A partner refusal that proves nothing moved: the leg is rejected with it. Anything else is an unknown outcome. */
const DEFINITE_PARTNER_REFUSALS = new Set([
  'bank.partner_insufficient_funds',
  'bank.partner_amount_invalid',
  'bank.asset_mismatch',
  'bank.same_space',
  'bank.account_restricted',
  'bank.partner_move_conflict',
]);

export interface SalaryServiceOptions {
  readonly payroll: PayrollPartner | null;
  /**
   * The partner's custody behind the posting freeze and the operator's partner stop (`BankRoot.custody`). Every split,
   * unsplit and reversal move goes through it; the payroll partner holds no raw bank (floor 4).
   */
  readonly custody: PartnerCustody;
  readonly accountDetails: AccountDetailsService;
  readonly sorter: Pick<IncomeSorterService, 'list' | 'minimumCredit'>;
  /** The owner's reversal window in days (`BANK_DIRECT_DEPOSIT_REVERSAL_DAYS`). Blank refuses every reversal. */
  readonly reversalDays: () => string | undefined;
  readonly now?: () => Date;
}

export class SalaryService {
  constructor(
    private readonly sql: Sql,
    private readonly options: SalaryServiceOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private payroll(): PayrollPartner {
    if (!this.options.payroll) throw railBank();
    return this.options.payroll;
  }

  /** The person's partner bank, guarded: a frozen ledger or a stopped partner refuses the move before it is asked. */
  private partnerBank(userId: string): PartnerBank {
    const bank = this.options.custody.bankFor(userId);
    if (!bank) {
      throw new BankError(
        'This person’s bank money is not held at the partner bank, so nothing can move there. Nothing moved.',
        'bank.partner_unset',
      );
    }
    return bank;
  }

  /** BK-salary-01: the account details salary is paid to, per owner-listed currency, and the name the account is held in. */
  async details(userId: string): Promise<SalaryDetails> {
    this.options.accountDetails.currencies();
    const payroll = this.payroll();
    const { currencies } = await this.options.accountDetails.list(userId);
    return {
      partnerBank: payroll.partner.label,
      network: payroll.label,
      holderName: payroll.partner.switches(userId).holderName,
      currencies,
    };
  }

  /** BK-salary-01: the employer form for one currency: the holder's name and the details, and the same as text. */
  async form(userId: string, currency: string): Promise<SalaryForm> {
    const payroll = this.payroll();
    const details = await this.options.accountDetails.get(userId, currency);
    const set = details.sets[0];
    if (!set) throw railBank();
    const holderName = payroll.partner.switches(userId).holderName;
    if (!holderName) {
      throw new BankError(
        'The partner bank has not given the name your account is held in, so no employer form can be made.',
        'bank.direct_deposit_holder_unknown',
      );
    }
    const reference = `Salary for ${holderName}`;
    const fields: Array<[string, string | null]> = [
      ['Account holder', holderName],
      ['Bank', set.partnerBank],
      ['Currency', details.currency],
      ['Account number', set.accountNumber],
      ['Sort code', set.sortCode],
      ['Routing number', set.routingNumber],
      ['IBAN', set.iban],
      ['BIC', set.bic],
      ['Reference', reference],
    ];
    const text = [
      'Direct deposit form',
      ...fields.filter(([, value]) => value !== null).map(([label, value]) => `${label}: ${value}`),
      ...set.restrictions.map((r) => `Note: ${r}`),
    ].join('\n');
    return {
      currency: details.currency,
      holderName,
      partnerBank: set.partnerBank,
      accountNumber: set.accountNumber,
      sortCode: set.sortCode,
      routingNumber: set.routingNumber,
      iban: set.iban,
      bic: set.bic,
      reference,
      text: `${text}\n`,
    };
  }

  /** The person's salary credits, newest first, each with its split. */
  async list(userId: string, limit: number): Promise<SalaryCredit[]> {
    const rows = await this.sql<CreditRow[]>`
      SELECT ${this.sql.unsafe(CREDIT_COLS)} FROM bank.salary_credits
       WHERE user_id = ${userId} AND state <> 'pending'
       ORDER BY created_at DESC, network_id DESC
       LIMIT ${limit}
    `;
    if (rows.length === 0) return [];
    const legs = await this.sql<LegRow[]>`
      SELECT ${this.sql.unsafe(LEG_COLS)} FROM bank.salary_split_legs
       WHERE network_id IN ${this.sql(rows.map((r) => r.network_id))}
    `;
    return rows.map((row) => toCredit(row, legs));
  }

  private async read(networkId: string): Promise<SalaryCredit | null> {
    const [row] = await this.sql<
      CreditRow[]
    >`SELECT ${this.sql.unsafe(CREDIT_COLS)} FROM bank.salary_credits WHERE network_id = ${networkId}`;
    if (!row) return null;
    const legs = await this.sql<LegRow[]>`SELECT ${this.sql.unsafe(LEG_COLS)} FROM bank.salary_split_legs WHERE network_id = ${networkId}`;
    return toCredit(row, legs);
  }

  /** A move the partner says it made, read back once by its key: the same reference, the same amount, or refused. */
  private async readBack(userId: string, key: string, made: PartnerMove): Promise<PartnerMove> {
    const back = await this.partnerBank(userId).moveByKey(key);
    if (!back || back.id !== made.id || back.amount !== made.amount) {
      throw new BankError(
        'The partner bank did not read back the move it reported, so the outcome is not known. The network may retry with the same id.',
        'bank.partner_reply_lost',
      );
    }
    return back;
  }

  /**
   * BK-salary-03: the network's credit. The same network id again finishes what is unfinished under the same keys and
   * otherwise changes nothing (`replayed: true`); the same id with other facts refuses `bank.direct_deposit_conflict`.
   */
  async credit(input: PayrollCredit): Promise<{ credit: SalaryCredit; replayed: boolean }> {
    const payroll = this.payroll();
    const amount = parseAmount(input.amount);
    if (amount <= 0n) throw new BankError('A salary credit needs an amount above zero.', 'bank.partner_amount_invalid');
    const owner = testPartnerDetailsOwner(payroll.partner, input.accountDetailsId);
    if (!owner || owner.currency !== input.currency || !this.options.accountDetails.currencies().includes(input.currency)) {
      throw new BankError('No account details with this id take payments in this currency.', 'bank.direct_deposit_details_unknown');
    }
    if (payroll.partner.switches(owner.userId).custody !== 'off') {
      throw new BankError(
        'This person’s bank money is not held at the partner bank, so a direct deposit has nowhere to land. Nothing was credited.',
        'bank.partner_unset',
      );
    }

    const [inserted] = await this.sql<Array<{ network_id: string }>>`
      INSERT INTO bank.salary_credits (network_id, user_id, account_details_id, asset_id, amount, originator_name, holder_name, state)
      VALUES (${input.networkId}, ${owner.userId}, ${input.accountDetailsId}, ${input.currency}, ${formatAmount(amount)}::numeric,
              ${input.originatorName}, ${input.holderName}, 'pending')
      ON CONFLICT (network_id) DO NOTHING
      RETURNING network_id
    `;
    let row = (await this.read(input.networkId))!;
    if (
      row.userId !== owner.userId ||
      row.assetId !== input.currency ||
      row.amount !== amount ||
      (await this.sameRequest(input)) === false
    ) {
      throw new BankError(
        `The network already sent ${input.networkId} with other details. Nothing was changed.`,
        'bank.direct_deposit_conflict',
      );
    }
    const replayed = !inserted;
    if (row.state === 'returned' || row.state === 'reversed') return { credit: row, replayed };

    if (row.state === 'pending') {
      const holder = payroll.partner.switches(owner.userId).holderName;
      if (!holder || holderNameKey(holder) !== holderNameKey(input.holderName)) {
        await this.sql`
          UPDATE bank.salary_credits SET state = 'returned', refusal_code = 'bank.direct_deposit_name_mismatch'
           WHERE network_id = ${input.networkId} AND state = 'pending'
        `;
        return { credit: (await this.read(input.networkId))!, replayed };
      }
      const main: PartnerAccountRef = { userId: owner.userId, assetId: input.currency, spaceId: null };
      const made = payroll.partner.receive(main, creditKey(input.networkId), amount);
      const back = await this.readBack(owner.userId, creditKey(input.networkId), made);
      // The network's own record: it carried this credit. Same key, same facts: a retry writes nothing new.
      await payroll.records?.record({ key: creditKey(input.networkId), direction: 'in', assetId: input.currency, amount });
      await this.sql.begin(async (tx) => {
        await tx`
          UPDATE bank.salary_credits SET state = 'received', credit_move_id = ${back.id}, received_at = ${this.now()}
           WHERE network_id = ${input.networkId} AND state = 'pending'
        `;
        await this.fixSplit(tx, input.networkId, owner.userId, input.currency, amount);
      });
      row = (await this.read(input.networkId))!;
    }
    await this.sendSplit(row);
    return { credit: (await this.read(input.networkId))!, replayed };
  }

  /** Whether a replay names the same originator, holder and details as the first; null when there was no first. */
  private async sameRequest(input: PayrollCredit): Promise<boolean | null> {
    const [row] = await this.sql<Array<Pick<CreditRow, 'account_details_id' | 'originator_name' | 'holder_name'>>>`
      SELECT account_details_id, originator_name, holder_name FROM bank.salary_credits WHERE network_id = ${input.networkId}
    `;
    if (!row) return null;
    return (
      row.account_details_id === input.accountDetailsId &&
      row.originator_name === input.originatorName &&
      row.holder_name === input.holderName
    );
  }

  /**
   * The person's split for this currency, fixed once for this credit: each leg of their live income sorter into a live
   * space of that currency, its share rounded down; nothing below the owner's smallest sorted credit, and nothing while
   * the owner has published no terms. What is not split stays in the main balance.
   */
  private async fixSplit(tx: TransactionSql, networkId: string, userId: string, assetId: string, amount: Amount): Promise<void> {
    const min = this.options.sorter.minimumCredit();
    if (min === null || amount < min) return;
    const sorter = (await this.options.sorter.list(userId)).find((s) => s.assetId === assetId && s.status === 'active');
    if (!sorter) return;
    for (const [position, leg] of sorter.legs.entries()) {
      if (leg.archived) continue;
      const share = legShare(amount, leg.shareBp);
      if (share <= 0n) continue;
      await tx`
        INSERT INTO bank.salary_split_legs (network_id, position, space_id, amount)
        VALUES (${networkId}, ${position}, ${leg.spaceId}::uuid, ${formatAmount(share)}::numeric)
        ON CONFLICT (network_id, position) DO NOTHING
      `;
    }
  }

  /** Sends each pending leg to the partner once under its key, and records the partner's answer, read back once. */
  private async sendSplit(credit: SalaryCredit): Promise<void> {
    const bank = this.partnerBank(credit.userId);
    for (const leg of credit.legs) {
      if (leg.status !== 'pending') continue;
      const key = splitKey(credit.networkId, leg.position);
      try {
        const made = await bank.move({
          key,
          from: { userId: credit.userId, assetId: credit.assetId, spaceId: null },
          to: { userId: credit.userId, assetId: credit.assetId, spaceId: leg.spaceId },
          amount: leg.amount,
        });
        const back = await this.readBack(credit.userId, key, made);
        await this.sql`
          UPDATE bank.salary_split_legs SET status = 'settled', move_id = ${back.id}
           WHERE network_id = ${credit.networkId} AND position = ${leg.position} AND status = 'pending'
        `;
      } catch (err) {
        if (err instanceof BankError && DEFINITE_PARTNER_REFUSALS.has(err.code)) {
          await this.sql`
            UPDATE bank.salary_split_legs SET status = 'rejected', rejection_code = ${err.code}
             WHERE network_id = ${credit.networkId} AND position = ${leg.position} AND status = 'pending'
          `;
          continue;
        }
        // Not known whether it moved: the leg stays pending and the network's retry sends it again under the same key.
        throw err;
      }
    }
  }

  /**
   * BK-salary-03: the employer's reversal of a credit, inside the owner's window. Split legs come back first, then the
   * whole credit leaves once. Asked again, it answers the reversal already made.
   */
  async reverse(networkId: string): Promise<SalaryCredit> {
    const payroll = this.payroll();
    const credit = await this.read(networkId);
    if (!credit) throw new BankError('The network carried no credit with this id.', 'bank.direct_deposit_not_found');
    if (credit.state === 'reversed') return credit;
    if (credit.state !== 'received' || !credit.receivedAt) {
      throw new BankError('Only a credit the account received can be reversed. Nothing moved.', 'bank.direct_deposit_not_received');
    }
    const days = parseReversalDays(this.options.reversalDays());
    if (days === null) {
      throw new BankError(
        'The owner has not published how long an employer may reverse a salary credit, so none is reversed.',
        'bank.direct_deposit_reversal_window_unset',
      );
    }
    if (this.now().getTime() > credit.receivedAt.getTime() + days * 86_400_000) {
      throw new BankError(
        `The ${days}-day window to reverse this credit has passed. Nothing moved.`,
        'bank.direct_deposit_reversal_window',
      );
    }
    await this.sendSplit(credit);
    const bank = this.partnerBank(credit.userId);
    const settled = (await this.read(networkId))!;
    const main: PartnerAccountRef = { userId: credit.userId, assetId: credit.assetId, spaceId: null };
    for (const leg of settled.legs) {
      if (leg.status !== 'settled') continue;
      const key = unsplitKey(networkId, leg.position);
      let made: PartnerMove;
      try {
        made = await bank.move({
          key,
          from: { userId: credit.userId, assetId: credit.assetId, spaceId: leg.spaceId },
          to: main,
          amount: leg.amount,
        });
      } catch (err) {
        // The space no longer holds its share: it stays there, and the main balance below decides the reversal.
        if (err instanceof BankError && err.code === 'bank.partner_insufficient_funds') continue;
        throw err;
      }
      const back = await this.readBack(credit.userId, key, made);
      await this.sql`
        UPDATE bank.salary_split_legs SET status = 'unsplit', unsplit_move_id = ${back.id}
         WHERE network_id = ${networkId} AND position = ${leg.position} AND status = 'settled'
      `;
    }
    let made: PartnerMove;
    try {
      made = await bank.move({
        key: reverseKey(networkId),
        from: main,
        to: partnerPayoutsAccount(credit.assetId),
        amount: credit.amount,
      });
    } catch (err) {
      if (err instanceof BankError && err.code === 'bank.partner_insufficient_funds') {
        throw new BankError(
          'The account no longer holds the amount the employer asks back, so the reversal was refused. Nothing more moved.',
          'bank.direct_deposit_reversal_insufficient',
        );
      }
      throw err;
    }
    const back = await this.readBack(credit.userId, reverseKey(networkId), made);
    await payroll.records?.record({ key: reverseKey(networkId), direction: 'out', assetId: credit.assetId, amount: credit.amount });
    await this.sql`
      UPDATE bank.salary_credits SET state = 'reversed', reversal_move_id = ${back.id}, reversed_at = ${this.now()}
       WHERE network_id = ${networkId} AND state = 'received'
    `;
    return (await this.read(networkId))!;
  }

  /**
   * BK-salary-03, the founders' rail desk: per currency, the network's own credits minus reversals against what the app
   * showed (credits and reversals the partner read back). "Matches", or the difference.
   */
  async rails(): Promise<SalaryRails | null> {
    const payroll = this.options.payroll;
    if (!payroll) return null;
    const app = await this.sql<Array<{ asset_id: string; credits: string; reversals: string }>>`
      SELECT asset_id,
             COALESCE(sum(amount) FILTER (WHERE credit_move_id IS NOT NULL), 0)::text AS credits,
             COALESCE(sum(amount) FILTER (WHERE reversal_move_id IS NOT NULL), 0)::text AS reversals
        FROM bank.salary_credits GROUP BY asset_id
    `;
    const network = new Map<string, { credits: Amount; reversals: Amount }>();
    const movements = payroll.records ? await payroll.records.movements() : null;
    for (const m of movements ?? []) {
      const sums = network.get(m.assetId) ?? { credits: 0n, reversals: 0n };
      if (m.direction === 'in' && m.key.startsWith('salary:credit:')) sums.credits += m.amount;
      if (m.direction === 'out' && m.key.startsWith('salary:reverse:')) sums.reversals += m.amount;
      network.set(m.assetId, sums);
    }
    const currencies = new Set([...app.map((r) => r.asset_id), ...network.keys()]);
    const lines = [...currencies].sort().map((currency): SalaryRailLine => {
      const row = app.find((r) => r.asset_id === currency);
      const shown = { credits: parseAmount(row?.credits ?? '0'), reversals: parseAmount(row?.reversals ?? '0') };
      const said = movements === null ? null : (network.get(currency) ?? { credits: 0n, reversals: 0n });
      const difference = said === null ? null : said.credits - said.reversals - (shown.credits - shown.reversals);
      return { currency, network: said, app: shown, matches: difference === null ? null : difference === 0n, difference };
    });
    return { label: `${payroll.label}, ${PAYROLL_SIM_RAIL}`, asOf: this.now(), lines };
  }
}
