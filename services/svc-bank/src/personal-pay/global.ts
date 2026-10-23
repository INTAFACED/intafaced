import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { InsufficientFundsError, formatAmount, parseAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { accountForSpace, type SpaceService } from '../spaces/space-service.js';
import { classifyAccount, classifyBic, type AccountKind } from './account-format.js';
import { personalPayError, PSP_BLOCKER } from './errors.js';
import type { Corridor, FxQuote, GlobalPorts } from './ports.js';
import { forwardKey, postToRail, reverseFromRail } from './post.js';
import {
  normalizeAccount,
  parseExchangeAllowance,
  parsePayeeControls,
  type ExchangeAllowance,
  type PayeeControls,
} from './payee-controls.js';
import { checkSendFields, parseSendFieldRules, type SendFieldRules } from './send-fields.js';

/**
 * Personal global send.
 *
 * Corridors, quotes and payouts come from injected ports. An empty port
 * refuses by name. Quote numbers are the provider's strings, checked for
 * decimal shape and never recomputed. Travel-rule fields are whatever
 * Nitro/Phantom recorded; an empty decision refuses before any post.
 * Saved recipients are the customer's own rows. Saving one does not claim
 * the bank exists.
 */

const SEND_STATUSES = ['submitted', 'held', 'sent', 'on_the_way', 'arrived', 'failed'] as const;
export type GlobalSendStatus = (typeof SEND_STATUSES)[number];

export interface RecipientView {
  readonly id: string;
  readonly label: string | null;
  readonly name: string;
  readonly account: string;
  readonly accountKind: AccountKind;
  readonly bic: string | null;
  readonly country: string;
  readonly createdAt: string;
}

export interface SendView {
  readonly id: string;
  readonly fromSpaceId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly toCurrency: string;
  readonly recipientId: string;
  readonly country: string;
  readonly deliveryMethod: string;
  readonly status: GlobalSendStatus;
  readonly failureCode: string | null;
  readonly failureBlocker: string | null;
  readonly providerRef: string | null;
  readonly quoteRate: string | null;
  readonly quoteFee: string | null;
  readonly quoteFeeAsset: string | null;
  readonly quoteReceive: string | null;
  readonly quoteValidUntil: string | null;
  readonly quoteEta: string | null;
  readonly ledgerTxId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type RecipientRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  label: string | null;
  name: string;
  account: string;
  account_kind: AccountKind;
  bic: string | null;
  country: string;
  removed_at: Date | null;
  created_at: Date;
};

type SendRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  from_space_id: string;
  asset_id: string;
  amount: string;
  to_currency: string;
  recipient_id: string;
  country: string;
  delivery_method: string;
  compliance: string | null;
  status: GlobalSendStatus;
  failure_code: string | null;
  failure_blocker: string | null;
  provider_ref: string | null;
  quote_rate: string | null;
  quote_fee: string | null;
  quote_fee_asset: string | null;
  quote_receive: string | null;
  quote_valid_until: Date | null;
  quote_eta: string | null;
  ledger_tx_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const DEFINITE = new Set([
  'bank.global_corridors_unset',
  'bank.global_corridor_unknown',
  'bank.global_amount_outside_corridor',
  'bank.global_fx_unset',
  'bank.global_payout_unset',
  'bank.global_payout_refused',
  'bank.global_travel_rule_undecided',
  'bank.global_travel_rule_incomplete',
  'bank.send_field_rules_unset',
  'bank.reference_rules_unset',
  'bank.reference_too_long',
  'bank.send_purpose_required',
  'bank.source_of_funds_required',
  'bank.global_insufficient_funds',
  'bank.payee_controls_unset',
  'bank.payee_blocked',
  'bank.exchange_allowance_unset',
  'bank.exchange_allowance_exceeded',
]);

export function canonicalCompliance(fields: Readonly<Record<string, string>> | undefined): string {
  if (!fields) return '';
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key]?.trim() ?? '';
    if (!value) continue;
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key) || value.length > 200) throw personalPayError('bank.personal_pay_request_invalid');
    sorted[key] = value;
  }
  return Object.keys(sorted).length === 0 ? '' : JSON.stringify(sorted);
}

function requireText(value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw personalPayError('bank.personal_pay_request_invalid');
  return trimmed;
}

function canonical(raw: string): { text: string; amount: Amount } {
  let amount: Amount;
  try {
    amount = parseAmount(raw);
  } catch {
    throw personalPayError('bank.personal_pay_request_invalid');
  }
  if (amount <= 0n) throw personalPayError('bank.personal_pay_request_invalid');
  return { text: formatAmount(amount), amount };
}

function providerDecimal(raw: string, allowZero: boolean): string {
  if (typeof raw !== 'string' || !/^\d+(\.\d{1,18})?$/.test(raw)) throw personalPayError('bank.global_fx_unusable');
  const amount = parseAmount(raw);
  if (amount < 0n || (!allowZero && amount === 0n)) throw personalPayError('bank.global_fx_unusable');
  return raw;
}

function providerInstant(raw: string): Date {
  if (typeof raw !== 'string' || !raw.includes('T') || Number.isNaN(Date.parse(raw))) throw personalPayError('bank.global_fx_unusable');
  return new Date(raw);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const pipe = text.lastIndexOf('|');
  const at = pipe > 0 ? text.slice(0, pipe) : '';
  const id = pipe > 0 ? text.slice(pipe + 1) : '';
  if (Number.isNaN(Date.parse(at)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw personalPayError('bank.global_cursor_invalid');
  }
  return { at, id };
}

function usableCorridor(row: Corridor): Corridor {
  const country = row.country?.trim().toUpperCase() ?? '';
  const currency = row.currency?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z]{3,8}$/.test(currency)) throw personalPayError('bank.global_corridors_unusable');
  if (!Array.isArray(row.deliveryMethods) || row.deliveryMethods.length === 0) throw personalPayError('bank.global_corridors_unusable');
  const deliveryMethods = row.deliveryMethods.map((method) => {
    const trimmed = typeof method === 'string' ? method.trim() : '';
    if (!trimmed || trimmed.length > 64) throw personalPayError('bank.global_corridors_unusable');
    return trimmed;
  });
  const bound = (value: string | null): string | null => {
    if (value === null) return null;
    if (!/^\d+(\.\d{1,18})?$/.test(value)) throw personalPayError('bank.global_corridors_unusable');
    const amount = parseAmount(value);
    if (amount <= 0n) throw personalPayError('bank.global_corridors_unusable');
    return value;
  };
  const cutOff = row.cutOffTime;
  if (cutOff !== null && (typeof cutOff !== 'string' || !cutOff.trim() || cutOff.length > 80)) {
    throw personalPayError('bank.global_corridors_unusable');
  }
  return {
    country,
    currency,
    deliveryMethods,
    minAmount: bound(row.minAmount),
    maxAmount: bound(row.maxAmount),
    cutOffTime: cutOff === null ? null : cutOff.trim(),
  };
}

function recipientView(row: RecipientRow): RecipientView {
  return {
    id: row.id,
    label: row.label,
    name: row.name,
    account: row.account,
    accountKind: row.account_kind,
    bic: row.bic,
    country: row.country,
    createdAt: row.created_at.toISOString(),
  };
}

function sendView(row: SendRow): SendView {
  return {
    id: row.id,
    fromSpaceId: row.from_space_id,
    assetId: row.asset_id,
    amount: row.amount,
    toCurrency: row.to_currency,
    recipientId: row.recipient_id,
    country: row.country,
    deliveryMethod: row.delivery_method,
    status: row.status,
    failureCode: row.failure_code,
    failureBlocker: row.failure_blocker,
    providerRef: row.provider_ref,
    quoteRate: row.quote_rate,
    quoteFee: row.quote_fee,
    quoteFeeAsset: row.quote_fee_asset,
    quoteReceive: row.quote_receive,
    quoteValidUntil: row.quote_valid_until ? row.quote_valid_until.toISOString() : null,
    quoteEta: row.quote_eta,
    ledgerTxId: row.ledger_tx_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class GlobalSendService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly spaces: SpaceService,
    private readonly ports: GlobalPorts,
    /** Owner-published purpose, source-of-funds and reference rules (`BANK_SEND_FIELD_RULES_JSON`). Blank refuses. */
    fieldRulesJson?: string,
    /** Owner-published payee controls (`BANK_PAYEE_CONTROLS_JSON`). Blank refuses every send. */
    payeeControlsJson?: string,
    /** Owner-published exchange payment allowance (`BANK_EXCHANGE_ALLOWANCE_JSON`). Blank refuses every send. */
    exchangeAllowanceJson?: string,
  ) {
    this.fieldRules = parseSendFieldRules(fieldRulesJson);
    this.payeeControls = parsePayeeControls(payeeControlsJson);
    this.exchangeAllowance = parseExchangeAllowance(exchangeAllowanceJson);
  }

  private readonly fieldRules: SendFieldRules | null;
  private readonly payeeControls: PayeeControls | null;
  private readonly exchangeAllowance: ExchangeAllowance | null;

  /** Whether the owner has published the exchange allowance, and its window; never the accounts or the limits. */
  exchangeAllowanceStatus(): { state: 'unset' | 'published'; windowDays: number | null; exchangeCount: number } {
    return this.exchangeAllowance
      ? { state: 'published', windowDays: this.exchangeAllowance.windowDays, exchangeCount: this.exchangeAllowance.accounts.size }
      : { state: 'unset', windowDays: null, exchangeCount: 0 };
  }

  /** Whether the owner has published the payee controls, and how many accounts they name (never which). */
  payeeControlsStatus(): { state: 'unset' | 'published'; blockedCount: number } {
    return this.payeeControls ? { state: 'published', blockedCount: this.payeeControls.blocked.size } : { state: 'unset', blockedCount: 0 };
  }

  /** Who answers a global send: null for a real or absent partner, or the TEST stand-in's label, shown beside its numbers. */
  partner(): { standIn: string | null } {
    return { standIn: this.ports.standIn?.label ?? null };
  }

  async corridors(): Promise<Corridor[]> {
    if (this.ports.corridors.status() !== 'live') throw personalPayError('bank.global_corridors_unset');
    const rows = await this.ports.corridors.list();
    if (!Array.isArray(rows)) throw personalPayError('bank.global_corridors_unusable');
    return rows.map(usableCorridor);
  }

  async validateRecipient(input: { account: string; bic?: string }): Promise<{
    format: 'valid' | 'invalid';
    formatKind: AccountKind | null;
    normalized: string | null;
    bicLookup:
      | { status: 'not_requested' }
      | { status: 'invalid'; code: 'bank.global_bic_format_invalid' }
      | { status: 'refused'; code: 'bank.global_bic_directory_unset'; blocker: typeof PSP_BLOCKER }
      | { status: 'unmatched' }
      | { status: 'matched'; bic: string; bankName: string };
  }> {
    const account = classifyAccount(input.account ?? '');
    if (!account.ok) {
      return { format: 'invalid', formatKind: null, normalized: null, bicLookup: { status: 'not_requested' } };
    }
    if (input.bic === undefined || input.bic.trim() === '') {
      return { format: 'valid', formatKind: account.kind, normalized: account.normalized, bicLookup: { status: 'not_requested' } };
    }
    const bic = classifyBic(input.bic);
    if (!bic.ok) {
      return {
        format: 'valid',
        formatKind: account.kind,
        normalized: account.normalized,
        bicLookup: { status: 'invalid', code: 'bank.global_bic_format_invalid' },
      };
    }
    if (this.ports.bic.status() !== 'live') {
      return {
        format: 'valid',
        formatKind: account.kind,
        normalized: account.normalized,
        bicLookup: { status: 'refused', code: 'bank.global_bic_directory_unset', blocker: PSP_BLOCKER },
      };
    }
    const hit = await this.ports.bic.lookup(bic.normalized);
    if (!hit) return { format: 'valid', formatKind: account.kind, normalized: account.normalized, bicLookup: { status: 'unmatched' } };
    const bankName = hit.bankName?.trim() ?? '';
    if (!bankName || hit.bic.replace(/\s+/g, '').toUpperCase() !== bic.normalized) throw personalPayError('bank.global_corridors_unusable');
    return {
      format: 'valid',
      formatKind: account.kind,
      normalized: account.normalized,
      bicLookup: { status: 'matched', bic: bic.normalized, bankName },
    };
  }

  async addRecipient(input: {
    userId: string;
    idempotencyKey: string;
    name: string;
    account: string;
    country: string;
    bic?: string;
    label?: string;
  }): Promise<RecipientView> {
    const idempotencyKey = requireText(input.idempotencyKey, 128);
    if (idempotencyKey.length < 8) throw personalPayError('bank.personal_pay_request_invalid');
    const name = requireText(input.name, 140);
    const country = input.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw personalPayError('bank.personal_pay_request_invalid');
    const account = classifyAccount(input.account);
    if (!account.ok) throw personalPayError('bank.global_account_format_invalid');
    let bic: string | null = null;
    if (input.bic !== undefined && input.bic.trim() !== '') {
      const parsed = classifyBic(input.bic);
      if (!parsed.ok) throw personalPayError('bank.global_bic_format_invalid');
      bic = parsed.normalized;
    }
    const label = input.label?.trim() ? requireText(input.label, 64) : null;
    const id = randomUUID();
    await this.sql`
      INSERT INTO bank.global_recipients (
        id, user_id, idempotency_key, label, name, account, account_kind, bic, country
      ) VALUES (
        ${id}, ${input.userId}, ${idempotencyKey}, ${label}, ${name}, ${account.normalized}, ${account.kind}, ${bic}, ${country}
      )
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
    `;
    const row = await this.recipientByKey(input.userId, idempotencyKey);
    const same =
      row.name === name &&
      row.account === account.normalized &&
      row.account_kind === account.kind &&
      row.bic === bic &&
      row.country === country &&
      row.label === label;
    if (!same) throw personalPayError('bank.global_conflict');
    return recipientView(row);
  }

  async listRecipients(input: { userId: string; limit?: number }): Promise<RecipientView[]> {
    if (input.limit === undefined) throw personalPayError('bank.global_list_limit_unset');
    const rows = await this.sql<RecipientRow[]>`
      SELECT id, user_id, idempotency_key, label, name, account, account_kind, bic, country, removed_at, created_at
      FROM bank.global_recipients
      WHERE user_id = ${input.userId} AND removed_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ${input.limit}
    `;
    return rows.map(recipientView);
  }

  async removeRecipient(input: { userId: string; recipientId: string; idempotencyKey: string }): Promise<{ removed: true }> {
    requireText(input.idempotencyKey, 128);
    const rows = await this.sql<RecipientRow[]>`
      SELECT id, user_id, idempotency_key, label, name, account, account_kind, bic, country, removed_at, created_at
      FROM bank.global_recipients WHERE id = ${input.recipientId} AND user_id = ${input.userId}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.global_recipient_not_found');
    if (!row.removed_at) {
      await this.sql`
        UPDATE bank.global_recipients SET removed_at = now()
        WHERE id = ${input.recipientId} AND user_id = ${input.userId} AND removed_at IS NULL
      `;
    }
    return { removed: true };
  }

  async quote(input: { asset: string; amount: string; toCurrency: string; now?: Date }): Promise<FxQuote> {
    if (this.ports.fx.status() !== 'live') throw personalPayError('bank.global_fx_unset');
    const asset = requireText(input.asset, 16).toUpperCase();
    const toCurrency = requireText(input.toCurrency, 8).toUpperCase();
    const money = canonical(input.amount);
    const quoted = await this.checkedQuote({ asset, amount: money.text, toCurrency }, input.now ?? new Date());
    return quoted;
  }

  async send(input: {
    userId: string;
    idempotencyKey: string;
    fromSpaceId: string;
    amount: string;
    toCurrency: string;
    recipientId: string;
    country: string;
    deliveryMethod: string;
    compliance?: Readonly<Record<string, string>>;
    now?: Date;
  }): Promise<SendView> {
    const now = input.now ?? new Date();
    const idempotencyKey = requireText(input.idempotencyKey, 128);
    if (idempotencyKey.length < 8) throw personalPayError('bank.personal_pay_request_invalid');
    const money = canonical(input.amount);
    const toCurrency = requireText(input.toCurrency, 8).toUpperCase();
    const country = input.country.trim().toUpperCase();
    const deliveryMethod = requireText(input.deliveryMethod, 64);
    if (!/^[A-Z]{2}$/.test(country)) throw personalPayError('bank.personal_pay_request_invalid');
    const compliance = canonicalCompliance(input.compliance);
    const space = await this.ownedSpace(input.userId, input.fromSpaceId, now);
    const recipient = await this.liveRecipient(input.userId, input.recipientId);
    const row = await this.instruction({
      userId: input.userId,
      idempotencyKey,
      fromSpaceId: space.id,
      assetId: space.assetId,
      amount: money.text,
      toCurrency,
      recipientId: recipient.id,
      country,
      deliveryMethod,
      compliance,
    });
    return this.drive(row, space, money.amount, now);
  }

  async list(input: { userId: string; limit?: number; cursor?: string }): Promise<{ items: SendView[]; nextCursor: string | null }> {
    if (input.limit === undefined) throw personalPayError('bank.global_list_limit_unset');
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = cursor
      ? await this.sql<SendRow[]>`
          SELECT id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
                 country, delivery_method, compliance, status, failure_code, failure_blocker, provider_ref,
                 quote_rate, quote_fee, quote_fee_asset, quote_receive, quote_valid_until, quote_eta,
                 ledger_tx_id, created_at, updated_at
          FROM bank.global_sends
          WHERE user_id = ${input.userId} AND (created_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit + 1}
        `
      : await this.sql<SendRow[]>`
          SELECT id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
                 country, delivery_method, compliance, status, failure_code, failure_blocker, provider_ref,
                 quote_rate, quote_fee, quote_fee_asset, quote_receive, quote_valid_until, quote_eta,
                 ledger_tx_id, created_at, updated_at
          FROM bank.global_sends
          WHERE user_id = ${input.userId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit + 1}
        `;
    const items = rows.slice(0, input.limit).map(sendView);
    const last = rows[input.limit - 1];
    return { items, nextCursor: rows.length > input.limit && last ? encodeCursor(last.created_at, last.id) : null };
  }

  async get(userId: string, id: string): Promise<SendView> {
    const row = await this.sendById(id, userId);
    if (!row) throw personalPayError('bank.global_not_found');
    return sendView(row);
  }

  async opsSummary(now = new Date()): Promise<{
    asOf: string;
    counts: Record<GlobalSendStatus, number>;
    volumes: { status: GlobalSendStatus; assetId: string; count: number; amount: string }[];
    rails: {
      corridors: 'unset' | 'live';
      fx: 'unset' | 'live';
      payout: 'unset' | 'live';
      bic: 'unset' | 'live';
      travelRule: 'undecided' | 'recorded';
      blocker: typeof PSP_BLOCKER;
      standIn: string | null;
    };
  }> {
    const grouped = await this.sql<{ status: GlobalSendStatus; asset_id: string; n: string; total: string }[]>`
      SELECT status, asset_id, count(*)::text AS n, sum(amount::numeric)::text AS total
      FROM bank.global_sends
      GROUP BY status, asset_id
    `;
    const counts = Object.fromEntries(SEND_STATUSES.map((status) => [status, 0])) as Record<GlobalSendStatus, number>;
    const volumes: { status: GlobalSendStatus; assetId: string; count: number; amount: string }[] = [];
    for (const row of grouped) {
      if (!(SEND_STATUSES as readonly string[]).includes(row.status)) throw personalPayError('bank.global_outcome_unknown');
      const count = Number(row.n);
      if (!Number.isSafeInteger(count)) throw personalPayError('bank.global_outcome_unknown');
      counts[row.status] += count;
      volumes.push({ status: row.status, assetId: row.asset_id, count, amount: formatAmount(parseAmount(row.total)) });
    }
    return {
      asOf: now.toISOString(),
      counts,
      volumes,
      rails: {
        corridors: this.ports.corridors.status(),
        fx: this.ports.fx.status(),
        payout: this.ports.payout.status(),
        bic: this.ports.bic.status(),
        travelRule: this.ports.travelRule.decision() ? 'recorded' : 'undecided',
        blocker: PSP_BLOCKER,
        standIn: this.ports.standIn?.label ?? null,
      },
    };
  }

  async opsFailed(input: { limit?: number }): Promise<(SendView & { userId: string })[]> {
    if (input.limit === undefined) throw personalPayError('bank.global_list_limit_unset');
    const rows = await this.sql<SendRow[]>`
      SELECT id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
             country, delivery_method, compliance, status, failure_code, failure_blocker, provider_ref,
             quote_rate, quote_fee, quote_fee_asset, quote_receive, quote_valid_until, quote_eta,
             ledger_tx_id, created_at, updated_at
      FROM bank.global_sends
      WHERE status = 'failed'
      ORDER BY created_at DESC, id DESC
      LIMIT ${input.limit}
    `;
    return rows.map((row) => ({ ...sendView(row), userId: row.user_id }));
  }

  async opsGet(id: string): Promise<SendView & { userId: string }> {
    const row = await this.sendById(id);
    if (!row) throw personalPayError('bank.global_not_found');
    return { ...sendView(row), userId: row.user_id };
  }

  private async drive(
    row: SendRow,
    space: { id: string; userId: string; assetId: string; kind: 'primary' | 'named' },
    amount: Amount,
    now: Date,
  ): Promise<SendView> {
    if (row.status === 'failed') throw personalPayError(row.failure_code ?? 'bank.global_payout_unset');
    if (row.status !== 'submitted') return sendView(row);

    if (this.ports.corridors.status() !== 'live') return this.definite(row, 'bank.global_corridors_unset');
    const catalogue = await this.corridors();
    const match = catalogue.find(
      (item) => item.country === row.country && item.currency === row.to_currency && item.deliveryMethods.includes(row.delivery_method),
    );
    if (!match) return this.definite(row, 'bank.global_corridor_unknown');
    // The corridor's own bounds, as the catalogue gives them: outside them nothing is quoted or posted.
    if (match.minAmount !== null && amount < parseAmount(match.minAmount)) {
      return this.definite(row, 'bank.global_amount_outside_corridor', `The smallest send for this destination is ${match.minAmount}.`);
    }
    if (match.maxAmount !== null && amount > parseAmount(match.maxAmount)) {
      return this.definite(row, 'bank.global_amount_outside_corridor', `The largest send for this destination is ${match.maxAmount}.`);
    }
    if (this.ports.fx.status() !== 'live') return this.definite(row, 'bank.global_fx_unset');
    if (this.ports.payout.status() !== 'live') return this.definite(row, 'bank.global_payout_unset');
    const decision = this.ports.travelRule.decision();
    if (!decision || !decision.decidedBy.trim() || !Array.isArray(decision.requiredFields)) {
      return this.definite(row, 'bank.global_travel_rule_undecided');
    }
    const supplied = row.compliance ? (JSON.parse(row.compliance) as Record<string, string>) : {};
    for (const field of decision.requiredFields) {
      if (!supplied[field]?.trim()) return this.definite(row, 'bank.global_travel_rule_incomplete');
    }

    if (!this.payeeControls) return this.definite(row, 'bank.payee_controls_unset');
    const payee = await this.recipientById(row.recipient_id);
    if (this.payeeControls.blocked.has(normalizeAccount(payee.account))) return this.definite(row, 'bank.payee_blocked');

    if (!this.exchangeAllowance) return this.definite(row, 'bank.exchange_allowance_unset');
    if (this.exchangeAllowance.accounts.has(normalizeAccount(payee.account))) {
      const limit = this.exchangeAllowance.limits.get(row.asset_id.toUpperCase());
      if (limit === undefined) return this.definite(row, 'bank.exchange_allowance_unset');
      // Every send to an exchange since the window opened counts, in the order they were taken in, this one included: two
      // sends made at the same moment cannot both fit a room that holds only one.
      const accounts = [...this.exchangeAllowance.accounts];
      const total = await this.sql<{ total: string | null }[]>`
        SELECT sum(s.amount::numeric)::text AS total
        FROM bank.global_sends me
        JOIN bank.global_sends s ON s.user_id = me.user_id AND s.asset_id = me.asset_id
        JOIN bank.global_recipients r ON r.id = s.recipient_id
        WHERE me.id = ${row.id} AND s.status <> 'failed'
          AND s.created_at > me.created_at - make_interval(days => ${this.exchangeAllowance.windowDays})
          AND (s.created_at, s.id) <= (me.created_at, me.id)
          AND upper(replace(r.account, ' ', '')) = ANY(${accounts})
      `;
      if (parseAmount(total[0]?.total ?? '0') > parseAmount(limit)) return this.definite(row, 'bank.exchange_allowance_exceeded');
    }

    const refusal = checkSendFields(this.fieldRules, {
      assetId: row.asset_id,
      amount: row.amount,
      toCurrency: row.to_currency,
      country: row.country,
      deliveryMethod: row.delivery_method,
      compliance: supplied,
    });
    if (refusal)
      return this.definite(
        row,
        refusal.code,
        'maxLength' in refusal ? `The reference can be at most ${refusal.maxLength} characters for this rail.` : undefined,
      );

    const quote = await this.checkedQuote({ asset: row.asset_id, amount: row.amount, toCurrency: row.to_currency }, now);
    const railId = this.ports.payout.railId().trim();
    if (!railId || railId.length > 64) throw personalPayError('bank.global_payout_unusable');
    const account = accountForSpace(space);
    let txId = row.ledger_tx_id;
    if (!txId) {
      // A hold placed while this send was being checked wins: nothing is posted for a held send.
      const fresh = await this.sendById(row.id);
      if (fresh && fresh.status !== 'submitted') return sendView(fresh);
      try {
        const existing = await this.ledger.getTxByKey(forwardKey(row.id));
        const tx = existing ?? (await postToRail(this.ledger, row.id, account, railId, amount));
        txId = tx.id;
        await this.sql`
          UPDATE bank.global_sends SET ledger_tx_id = ${txId}, updated_at = now()
          WHERE id = ${row.id} AND status IN ('submitted', 'held') AND ledger_tx_id IS NULL
        `;
        // A hold that landed while the forward entry was being posted stands: the debit is recorded on the held send and no
        // payout is made until someone else releases it. Release then carries on from here without posting again.
        const after = await this.sendById(row.id);
        if (after && after.status !== 'submitted') return sendView(after);
      } catch (err) {
        if (err instanceof InsufficientFundsError) return this.definite(row, 'bank.global_insufficient_funds', err.message);
        throw err;
      }
    }
    let answer: Awaited<ReturnType<GlobalPorts['payout']['submit']>>;
    try {
      answer = await this.ports.payout.submit({
        sendId: row.id,
        idempotencyKey: row.idempotency_key,
        amount: row.amount,
        assetId: row.asset_id,
        toCurrency: row.to_currency,
        recipientId: row.recipient_id,
      });
    } catch {
      throw personalPayError('bank.global_outcome_unknown');
    }
    if (!answer.ok) {
      try {
        await reverseFromRail(this.ledger, row.id, account, railId, amount);
      } catch {
        throw personalPayError('bank.global_outcome_unknown');
      }
      return this.definite(row, 'bank.global_payout_refused');
    }
    const providerRef = answer.providerRef?.trim() ?? '';
    if (!providerRef || providerRef.length > 128 || !['sent', 'on_the_way', 'arrived'].includes(answer.status)) {
      throw personalPayError('bank.global_outcome_unknown');
    }
    await this.sql`
      UPDATE bank.global_sends
      SET status = ${answer.status}, provider_ref = ${providerRef}, ledger_tx_id = ${txId},
          quote_rate = ${quote.rate}, quote_fee = ${quote.fee}, quote_fee_asset = ${quote.feeAsset},
          quote_receive = ${quote.receiveAmount}, quote_valid_until = ${quote.validUntil}::timestamptz,
          quote_eta = ${quote.eta}, failure_code = NULL, failure_blocker = NULL, updated_at = now()
      WHERE id = ${row.id} AND status = 'submitted'
    `;
    return sendView(await this.mustSend(row.id));
  }

  private async definite(row: SendRow, code: string, detail?: string): Promise<never> {
    if (row.ledger_tx_id && code !== 'bank.global_payout_refused' && code !== 'bank.global_insufficient_funds') {
      throw personalPayError('bank.global_outcome_unknown');
    }
    if (!DEFINITE.has(code)) throw personalPayError(code);
    const blocker = personalPayError(code).blocker ?? null;
    await this.sql`
      UPDATE bank.global_sends
      SET status = 'failed', failure_code = ${code}, failure_blocker = ${blocker}, ledger_tx_id = NULL, updated_at = now()
      WHERE id = ${row.id} AND status = 'submitted'
    `;
    throw personalPayError(code, detail);
  }

  private async checkedQuote(input: { asset: string; amount: string; toCurrency: string }, now: Date): Promise<FxQuote> {
    let quoted: FxQuote;
    try {
      quoted = await this.ports.fx.quote(input);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'bank.global_fx_unusable') throw err;
      throw personalPayError('bank.global_fx_unusable');
    }
    const rate = providerDecimal(quoted.rate, false);
    const fee = providerDecimal(quoted.fee, true);
    const receiveAmount = providerDecimal(quoted.receiveAmount, false);
    const feeAsset = quoted.feeAsset?.trim().toUpperCase() ?? '';
    if (!/^[A-Z0-9]{2,16}$/.test(feeAsset)) throw personalPayError('bank.global_fx_unusable');
    const validUntil = providerInstant(quoted.validUntil);
    if (validUntil.getTime() <= now.getTime()) throw personalPayError('bank.global_quote_expired');
    const etaDate = providerInstant(quoted.eta);
    void etaDate;
    return { rate, fee, feeAsset, receiveAmount, validUntil: quoted.validUntil, eta: quoted.eta };
  }

  private async instruction(input: {
    userId: string;
    idempotencyKey: string;
    fromSpaceId: string;
    assetId: string;
    amount: string;
    toCurrency: string;
    recipientId: string;
    country: string;
    deliveryMethod: string;
    compliance: string;
  }): Promise<SendRow> {
    const id = randomUUID();
    await this.sql`
      INSERT INTO bank.global_sends (
        id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
        country, delivery_method, compliance, status
      ) VALUES (
        ${id}, ${input.userId}, ${input.idempotencyKey}, ${input.fromSpaceId}, ${input.assetId}, ${input.amount},
        ${input.toCurrency}, ${input.recipientId}, ${input.country}, ${input.deliveryMethod},
        ${input.compliance || null}, 'submitted'
      )
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
    `;
    const row = await this.sendByKey(input.userId, input.idempotencyKey);
    if (!row) throw personalPayError('bank.global_outcome_unknown');
    const same =
      row.from_space_id === input.fromSpaceId &&
      row.asset_id === input.assetId &&
      row.amount === input.amount &&
      row.to_currency === input.toCurrency &&
      row.recipient_id === input.recipientId &&
      row.country === input.country &&
      row.delivery_method === input.deliveryMethod &&
      (row.compliance ?? '') === input.compliance;
    if (!same) throw personalPayError('bank.global_conflict');
    return row;
  }

  private async ownedSpace(userId: string, spaceId: string, now: Date) {
    let space;
    try {
      space = await this.spaces.get(spaceId);
    } catch (err) {
      if (err instanceof BankError && err.code === 'bank.space_not_found') throw personalPayError('bank.global_space_not_found');
      throw err;
    }
    if (space.userId !== userId) throw personalPayError('bank.global_space_not_found');
    return this.spaces.resolveForDebit(spaceId, now);
  }

  private async liveRecipient(userId: string, id: string): Promise<RecipientRow> {
    const rows = await this.sql<RecipientRow[]>`
      SELECT id, user_id, idempotency_key, label, name, account, account_kind, bic, country, removed_at, created_at
      FROM bank.global_recipients WHERE id = ${id} AND user_id = ${userId} AND removed_at IS NULL
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.global_recipient_not_found');
    return row;
  }

  private async recipientById(id: string): Promise<RecipientRow> {
    const rows = await this.sql<RecipientRow[]>`
      SELECT id, user_id, idempotency_key, label, name, account, account_kind, bic, country, removed_at, created_at
      FROM bank.global_recipients WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.global_recipient_not_found');
    return row;
  }

  /** Carries on a send whose hold was released: the same steps, the same checks, the same keys. */
  async resume(id: string, now: Date = new Date()): Promise<SendView> {
    const row = await this.mustSend(id);
    const space = await this.ownedSpace(row.user_id, row.from_space_id, now);
    return this.drive(row, space, canonical(row.amount).amount, now);
  }

  private async recipientByKey(userId: string, idempotencyKey: string): Promise<RecipientRow> {
    const rows = await this.sql<RecipientRow[]>`
      SELECT id, user_id, idempotency_key, label, name, account, account_kind, bic, country, removed_at, created_at
      FROM bank.global_recipients WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey}
    `;
    const row = rows[0];
    if (!row) throw personalPayError('bank.global_recipient_not_found');
    return row;
  }

  private async sendByKey(userId: string, idempotencyKey: string): Promise<SendRow | null> {
    const rows = await this.sql<SendRow[]>`
      SELECT id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
             country, delivery_method, compliance, status, failure_code, failure_blocker, provider_ref,
             quote_rate, quote_fee, quote_fee_asset, quote_receive, quote_valid_until, quote_eta,
             ledger_tx_id, created_at, updated_at
      FROM bank.global_sends WHERE user_id = ${userId} AND idempotency_key = ${idempotencyKey}
    `;
    return rows[0] ?? null;
  }

  private async sendById(id: string, userId?: string): Promise<SendRow | null> {
    const rows = userId
      ? await this.sql<SendRow[]>`
          SELECT id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
                 country, delivery_method, compliance, status, failure_code, failure_blocker, provider_ref,
                 quote_rate, quote_fee, quote_fee_asset, quote_receive, quote_valid_until, quote_eta,
                 ledger_tx_id, created_at, updated_at
          FROM bank.global_sends WHERE id = ${id} AND user_id = ${userId}
        `
      : await this.sql<SendRow[]>`
          SELECT id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, recipient_id,
                 country, delivery_method, compliance, status, failure_code, failure_blocker, provider_ref,
                 quote_rate, quote_fee, quote_fee_asset, quote_receive, quote_valid_until, quote_eta,
                 ledger_tx_id, created_at, updated_at
          FROM bank.global_sends WHERE id = ${id}
        `;
    return rows[0] ?? null;
  }

  private async mustSend(id: string): Promise<SendRow> {
    const row = await this.sendById(id);
    if (!row) throw personalPayError('bank.global_not_found');
    return row;
  }
}
