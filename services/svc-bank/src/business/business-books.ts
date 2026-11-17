import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import {
  NO_PARTNER_BANK_CODE,
  PARTNER_FEES_OWNER,
  PARTNER_PAYOUTS_OWNER,
  PARTNER_PAY_INS_OWNER,
  type PartnerBank,
  type PartnerHistoryRules,
  type PartnerMove,
} from '../partner/partner-bank.js';
import { partnerMovesBetween } from '../partner/partner-history.js';
import { TEST_PARTNER_MERCHANT } from '../partner/test-partner.js';
import { cardCaptureKey } from './business-cards.js';
import { businessPartnerAccount, type BusinessPermission, type BusinessTeamService } from './business-team.js';
import { renderBookStatement, type BookLine, type BookStatementFormat } from './statement-formats.js';

/**
 * A BUSINESS KEEPS ITS BOOKS IN ORDER (J-bank-23 #1 #2 #3; BK-bexp-03, BK-bexp-04, BK-bexp-05).
 *
 * The business's money and every line of it are the partner bank's (OWNER 226): a line here is one line of the partner's
 * own record for the business's account, `business:<account id>`, named by the partner's reference. svc-bank keeps only
 * the business's bookkeeping about those lines. Nothing here moves money or posts to the ledger.
 *
 *   accounting   Connecting accounting software needs `vendor.accounting`, which is switched off in this build. Asking
 *                keeps the connection's record (switched off, who asked, how many times) and connects nothing. The bank
 *                feed by file works instead: a CSV of the lines with their coding, for the accounting software to import.
 *   coding       A rule "payee contains <text> sets <category>" (and a GL code) can be tried before it is saved: the test
 *                run lists the lines it would code. Saved, it codes every line not yet coded that matches, the old ones
 *                and each new one as it arrives, on the next read. A person codes one line or many at once (bulk); a
 *                person's code is never overwritten by a rule.
 *   statements   A period's statement in CSV, MT940, CAMT.053 or QIF. Each is checked against the partner's own statement
 *                of the same period before it is given: the same line count, and its opening plus its lines is the
 *                partner's closing balance, or it refuses `bank.statement_mismatch`. The partner's history window bounds
 *                the period, and a period reaching back past its strong customer authentication age needs a fresh
 *                confirmation (`bank.step_up.businessBooks.exportStatement`).
 */

export const ACCOUNTING_VENDOR_CODE = 'vendor.accounting';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SPAN_MS = 366 * DAY_MS;
const MAX_BULK = 200;

const PAYEE_RE = /^[^\p{Cc}]{1,80}$/u;
const CATEGORY_RE = /^[^\p{Cc}]{1,60}$/u;
const GL_RE = /^[A-Za-z0-9][A-Za-z0-9 .\-/]{0,31}$/;

export interface BookLineView extends BookLine {
  readonly partnerKey: string;
  readonly codedBy: 'rule' | 'person' | null;
  readonly ruleId: string | null;
}

export interface CodingRule {
  readonly id: string;
  readonly payeeContains: string;
  readonly category: string;
  readonly glCode: string | null;
  readonly createdAt: Date;
}

export interface AccountingConnection {
  readonly status: 'switched_off';
  readonly needs: typeof ACCOUNTING_VENDOR_CODE;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly attempts: number;
}

export interface BooksOverview {
  readonly account: { id: string; name: string; assetId: string };
  readonly permissions: BusinessPermission[];
  readonly connection: AccountingConnection | null;
  readonly rules: CodingRule[];
  readonly partnerLabel: string | null;
  readonly historyRules: PartnerHistoryRules | null;
}

export interface BookStatementFileOut {
  readonly format: BookStatementFormat;
  readonly fileName: string;
  readonly contentType: string;
  readonly bodyBase64: string;
  readonly sha256: string;
  readonly opening: string;
  readonly closing: string;
  readonly lineCount: number;
  /** The partner's own statement the file was checked against. */
  readonly partner: { label: string; closing: string; lines: number; asOf: Date };
}

interface Range {
  from: Date;
  to: Date;
}
interface RuleRow {
  id: string;
  account_id: string;
  payee_contains: string;
  category: string;
  gl_code: string | null;
  created_at: Date;
}
interface CodeRow {
  line_id: string;
  category: string | null;
  gl_code: string | null;
  coded_by: 'rule' | 'person';
  rule_id: string | null;
}
interface ConnectionRow {
  status: 'switched_off';
  needs: string;
  requested_by: string;
  requested_at: Date;
  attempts: number;
}

const toRule = (r: RuleRow): CodingRule => ({
  id: r.id,
  payeeContains: r.payee_contains,
  category: r.category,
  glCode: r.gl_code,
  createdAt: r.created_at,
});
const matches = (payee: string, contains: string) => payee.toLowerCase().includes(contains.toLowerCase());

function invalid(message: string): BankError {
  return new BankError(message, 'bank.business_books_field_invalid');
}
function noPartner(): BankError {
  return new BankError('This business’s money is not held at a partner bank, so it has no statement.', NO_PARTNER_BANK_CODE);
}

/** A category, a GL code or both; blank text is none. */
function coding(input: { category?: string | null; glCode?: string | null }): { category: string | null; glCode: string | null } {
  const category = input.category?.trim() || null;
  const glCode = input.glCode?.trim() || null;
  if (category !== null && !CATEGORY_RE.test(category)) throw invalid('A category is 1 to 60 characters.');
  if (glCode !== null && !GL_RE.test(glCode)) throw invalid('A GL code is 1 to 32 letters, digits, spaces, dots, dashes or slashes.');
  return { category, glCode };
}

export class BusinessBooksService {
  constructor(
    private readonly sql: Sql,
    private readonly team: BusinessTeamService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async overview(accountId: string, userId: string): Promise<BooksOverview> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'view');
    return {
      account: { id: seat.account.id, name: seat.account.name, assetId: seat.account.assetId },
      permissions: seat.permissions,
      connection: await this.connectionOf(accountId),
      rules: (await this.rulesOf(this.sql, accountId)).map(toRule),
      partnerLabel: seat.partner?.label ?? null,
      historyRules: seat.partner?.historyRules ?? null,
    };
  }

  // ── Accounting connection (BK-bexp-03) ──────────────────────────────────────

  /** Asks to connect accounting software: switched off in this build, so the record is kept and nothing is connected. */
  async connectAccounting(accountId: string, userId: string): Promise<AccountingConnection> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'manage_team');
    const rows = await this.sql<ConnectionRow[]>`
      INSERT INTO bank.business_accounting_connections (account_id, status, needs, requested_by)
      VALUES (${accountId}::uuid, 'switched_off', ${ACCOUNTING_VENDOR_CODE}, ${userId})
      ON CONFLICT (account_id) DO UPDATE SET attempts = bank.business_accounting_connections.attempts + 1,
        requested_by = EXCLUDED.requested_by, requested_at = now()
      RETURNING *
    `;
    return toConnection(rows[0]!);
  }

  // ── Lines and coding (BK-bexp-04) ───────────────────────────────────────────

  /**
   * The partner's lines for the business's account in `[from, to)`, oldest first, each with its coding. A line no person
   * has coded that a saved rule matches is coded by that rule now (the oldest rule wins), and stays coded.
   */
  async lines(accountId: string, userId: string, range: Range): Promise<BookLineView[]> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'view');
    const partner = this.partnerOf(seat.partner);
    this.checkRange(range, partner, { sca: false });
    return this.codedLines(accountId, seat.account.assetId, partner, range, true);
  }

  /** What a rule would code, before it is saved: every line in the range whose payee contains the text. Changes nothing. */
  async testRule(accountId: string, userId: string, input: Range & { payeeContains: string }): Promise<BookLineView[]> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'export');
    const contains = this.payeeText(input.payeeContains);
    const partner = this.partnerOf(seat.partner);
    this.checkRange(input, partner, { sca: false });
    const lines = await this.codedLines(accountId, seat.account.assetId, partner, input, false);
    return lines.filter((l) => matches(l.payee, contains));
  }

  /** Saves a rule. The same id on the same terms is the same rule; it codes matching lines on their next read. */
  async saveRule(
    accountId: string,
    userId: string,
    input: { ruleId: string; payeeContains: string; category: string; glCode?: string | null },
  ): Promise<CodingRule> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'export');
    const contains = this.payeeText(input.payeeContains);
    const { category, glCode } = coding(input);
    if (category === null) throw invalid('A rule sets a category.');
    const rows = await this.sql<RuleRow[]>`
      INSERT INTO bank.business_coding_rules (id, account_id, payee_contains, category, gl_code, created_by)
      VALUES (${input.ruleId}::uuid, ${accountId}::uuid, ${contains}, ${category}, ${glCode}, ${userId})
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      RETURNING *
    `;
    const row = rows[0]!;
    if (row.account_id !== accountId || row.payee_contains !== contains || row.category !== category || row.gl_code !== glCode) {
      throw new BankError('This rule id is already used on different terms.', 'bank.business_request_conflict');
    }
    return toRule(row);
  }

  /**
   * A person codes one line or many at once (bulk): each must be a line of the partner's record for this business in the
   * range. A person's code replaces any code a rule gave.
   */
  async codeLines(
    accountId: string,
    userId: string,
    input: Range & { lineIds: readonly string[]; category?: string | null; glCode?: string | null },
  ): Promise<BookLineView[]> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'export');
    const ids = [...new Set(input.lineIds)];
    if (ids.length === 0 || ids.length > MAX_BULK) throw invalid(`Code 1 to ${MAX_BULK} lines at once.`);
    const code = coding(input);
    if (code.category === null && code.glCode === null) throw invalid('Give a category, a GL code or both.');
    const partner = this.partnerOf(seat.partner);
    this.checkRange(input, partner, { sca: false });
    const known = new Set((await this.codedLines(accountId, seat.account.assetId, partner, input, false)).map((l) => l.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BankError(
        `No line ${unknown[0]} is on this business’s statement for the period. Nothing was coded.`,
        'bank.business_line_not_found',
      );
    }
    await transaction(this.sql, async (tx) => {
      for (const id of ids) {
        await tx`
          INSERT INTO bank.business_line_codes (account_id, line_id, category, gl_code, coded_by, coded_by_user)
          VALUES (${accountId}::uuid, ${id}, ${code.category}, ${code.glCode}, 'person', ${userId})
          ON CONFLICT (account_id, line_id) DO UPDATE SET category = EXCLUDED.category, gl_code = EXCLUDED.gl_code,
            coded_by = 'person', rule_id = NULL, coded_by_user = EXCLUDED.coded_by_user, coded_at = now()
        `;
      }
    });
    const coded = new Set(ids);
    return (await this.codedLines(accountId, seat.account.assetId, partner, input, false)).filter((l) => coded.has(l.id));
  }

  // ── Statements (BK-bexp-05) ─────────────────────────────────────────────────

  /** True when this period reaches back past the partner's strong customer authentication age. */
  async needsStrongAuth(accountId: string, userId: string, range: Range): Promise<boolean> {
    const seat = await this.team.seat(accountId, userId);
    const partner = this.partnerOf(seat.partner);
    return this.checkRange(range, partner, { sca: true }).needsSca;
  }

  /**
   * One period's statement in one format, checked against the partner's own statement of that period first. `confirm`
   * runs before any line is read when the period needs a fresh strong customer authentication.
   */
  async exportStatement(
    accountId: string,
    userId: string,
    input: Range & { format: BookStatementFormat },
    confirm: () => Promise<void>,
  ): Promise<BookStatementFileOut> {
    const seat = await this.team.seat(accountId, userId);
    this.need(seat.permissions, 'export');
    const partner = this.partnerOf(seat.partner);
    const { needsSca } = this.checkRange(input, partner, { sca: true });
    if (needsSca) await confirm();
    if (!partner.statement) {
      throw new BankError(`${partner.label} offers no statement, so none can be checked or given.`, 'bank.partner_statement_unavailable');
    }
    const lines = await this.codedLines(accountId, seat.account.assetId, partner, input, true);
    const theirs = await partner.statement(businessPartnerAccount(accountId, seat.account.assetId), { from: input.from, to: input.to });
    const net = lines.reduce((t, l) => t + l.amount, 0n);
    if (theirs.lines !== lines.length || theirs.opening + net !== theirs.closing) {
      throw new BankError(
        `${partner.label}’s statement lists ${theirs.lines} lines closing at ${formatAmount(theirs.closing)}, and its record here gives ${lines.length} lines closing at ${formatAmount(theirs.opening + net)}, so no file was made.`,
        'bank.statement_mismatch',
      );
    }
    const file = renderBookStatement(
      {
        accountId,
        accountName: seat.account.name,
        currency: seat.account.assetId,
        servicer: partner.label,
        from: input.from,
        to: input.to,
        opening: theirs.opening,
        closing: theirs.closing,
        lines,
        generatedAt: this.clock(),
      },
      input.format,
    );
    return {
      format: file.format,
      fileName: file.fileName,
      contentType: file.contentType,
      bodyBase64: file.body.toString('base64'),
      sha256: createHash('sha256').update(file.body).digest('hex'),
      opening: formatAmount(theirs.opening),
      closing: formatAmount(theirs.closing),
      lineCount: lines.length,
      partner: { label: theirs.label, closing: formatAmount(theirs.closing), lines: theirs.lines, asOf: theirs.asOf },
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private partnerOf(partner: PartnerBank | null): PartnerBank {
    if (!partner) throw noPartner();
    return partner;
  }

  private payeeText(raw: string): string {
    const text = raw.trim();
    if (!PAYEE_RE.test(text)) throw invalid('A payee text is 1 to 80 characters.');
    return text;
  }

  /**
   * The period must start before it ends, span at most 366 days, and start inside the partner's history window. With
   * `sca`, whether it reaches back past the partner's strong customer authentication age.
   */
  private checkRange(range: Range, partner: PartnerBank, opts: { sca: boolean }): { needsSca: boolean } {
    const from = range.from.getTime();
    const to = range.to.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new BankError('The period’s end is not after its start.', 'bank.statement_range');
    }
    if (to - from > MAX_SPAN_MS) throw new BankError('A statement covers at most 366 days.', 'bank.statement_range');
    const rules = partner.historyRules;
    const now = this.clock().getTime();
    if (!rules) {
      // A partner that declares no history window gives no statement further back than it says: none is assumed.
      if (opts.sca) {
        throw new BankError(`${partner.label} has not said how far back its record reaches.`, 'bank.partner_statement_unavailable');
      }
      return { needsSca: false };
    }
    const earliest = now - rules.historyDays * DAY_MS;
    if (from < earliest) {
      throw new BankError(
        `${rules.label} keeps ${rules.historyDays} days of history, from ${new Date(earliest).toISOString().slice(0, 10)}. Choose a later start.`,
        'bank.statement_history_window',
      );
    }
    return { needsSca: opts.sca && from < now - rules.scaAfterDays * DAY_MS };
  }

  private async codedLines(
    accountId: string,
    assetId: string,
    partner: PartnerBank,
    range: Range,
    applyRules: boolean,
  ): Promise<BookLineView[]> {
    const owner = businessPartnerAccount(accountId, assetId).userId;
    const moves = (await partnerMovesBetween(partner, owner, { assetId, from: range.from, to: range.to })).reverse();
    const payees = await this.payeesOf(moves);
    const codes = new Map(
      (
        await this.sql<CodeRow[]>`
          SELECT line_id, category, gl_code, coded_by, rule_id FROM bank.business_line_codes
           WHERE account_id = ${accountId}::uuid AND line_id = ANY(${moves.map((m) => m.id)}::text[])
        `
      ).map((c) => [c.line_id, c]),
    );
    const rules = applyRules ? await this.rulesOf(this.sql, accountId) : [];
    const out: BookLineView[] = [];
    for (const move of moves) {
      const payee = payees.get(move.id) ?? 'Transfer';
      let code = codes.get(move.id) ?? null;
      if (!code && rules.length > 0) {
        const rule = rules.find((r) => matches(payee, r.payee_contains));
        if (rule) {
          await this.sql`
            INSERT INTO bank.business_line_codes (account_id, line_id, category, gl_code, coded_by, rule_id)
            VALUES (${accountId}::uuid, ${move.id}, ${rule.category}, ${rule.gl_code}, 'rule', ${rule.id}::uuid)
            ON CONFLICT (account_id, line_id) DO NOTHING
          `;
          code =
            (
              await this.sql<CodeRow[]>`
                SELECT line_id, category, gl_code, coded_by, rule_id FROM bank.business_line_codes
                 WHERE account_id = ${accountId}::uuid AND line_id = ${move.id}
              `
            )[0] ?? null;
        }
      }
      const incoming = move.to.userId === owner;
      out.push({
        id: move.id,
        bookedAt: move.movedAt,
        amount: incoming ? move.amount : -move.amount,
        payee,
        partnerKey: move.key,
        category: code?.category ?? null,
        glCode: code?.gl_code ?? null,
        codedBy: code?.coded_by ?? null,
        ruleId: code?.rule_id ?? null,
      });
    }
    return out;
  }

  /** Who each line was with, from what svc-bank itself sent the partner: a card's merchant, a payout's payees. */
  private async payeesOf(moves: readonly PartnerMove[]): Promise<Map<string, string>> {
    const captureKeys = moves.filter((m) => m.key.startsWith(cardCaptureKey(''))).map((m) => m.key);
    const merchants = new Map(
      captureKeys.length === 0
        ? []
        : (
            await this.sql<Array<{ partner_key: string; merchant: string }>>`
              SELECT partner_key, merchant FROM bank.business_card_purchases WHERE partner_key = ANY(${captureKeys}::text[])
            `
          ).map((r) => [r.partner_key, r.merchant]),
    );
    const out = new Map<string, string>();
    for (const m of moves) {
      const other = m.from.userId.startsWith('business:') && m.from.spaceId === null && m.to.userId !== m.from.userId ? m.to : m.from;
      let payee: string;
      if (merchants.has(m.key)) payee = merchants.get(m.key)!;
      else if (m.payees && m.payees.length > 0) {
        const names = m.payees.slice(0, 3).map((p) => p.name);
        payee = m.payees.length > 3 ? `${names.join(', ')} and ${m.payees.length - 3} more` : names.join(', ');
      } else if (other.userId === PARTNER_PAY_INS_OWNER) payee = 'Pay-in';
      else if (other.userId === PARTNER_PAYOUTS_OWNER) payee = 'Outbound payment';
      else if (other.userId === PARTNER_FEES_OWNER) payee = 'Partner fee';
      else if (other.userId === TEST_PARTNER_MERCHANT) payee = 'TEST merchant';
      else if (m.key.startsWith('bank.business.reimbursement:')) payee = 'Team reimbursement';
      else payee = 'Transfer';
      out.set(m.id, payee);
    }
    return out;
  }

  private async rulesOf(sql: Sql, accountId: string): Promise<RuleRow[]> {
    return sql<RuleRow[]>`
      SELECT * FROM bank.business_coding_rules WHERE account_id = ${accountId}::uuid ORDER BY created_at, id LIMIT 200
    `;
  }

  private async connectionOf(accountId: string): Promise<AccountingConnection | null> {
    const rows = await this.sql<ConnectionRow[]>`
      SELECT * FROM bank.business_accounting_connections WHERE account_id = ${accountId}::uuid
    `;
    return rows[0] ? toConnection(rows[0]) : null;
  }

  private need(permissions: readonly BusinessPermission[], permission: BusinessPermission): void {
    if (!permissions.includes(permission)) {
      throw new BankError(
        `Your role on this business does not include ${permission.replace('_', ' ')}, so this was refused. Nothing changed.`,
        'bank.business_role_forbidden',
      );
    }
  }
}

function toConnection(r: ConnectionRow): AccountingConnection {
  return {
    status: r.status,
    needs: ACCOUNTING_VENDOR_CODE,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    attempts: r.attempts,
  };
}
