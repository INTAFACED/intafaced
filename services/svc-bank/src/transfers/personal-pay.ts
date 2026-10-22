/**
 * Personal send, receipt, and payment request.
 *
 * The ledger is the only movement (`transfers.transferToUser` → `bankTransfer`).
 * Rows here are the note, the parties, and the request. They are not a balance.
 *
 * A published fee greater than zero is refused (`bank.personal_transfer_fee_unwired`):
 * `bankTransfer` has no fee leg, and a second post could succeed without the
 * transfer or the other way round. An empty terms row is not a zero fee.
 */
import { grantedLimits } from './limit-requests.js';
import type { Sql, TransactionSql } from 'postgres';
import {
  bankTransferKey,
  formatAmount,
  provesPostNotCommitted,
  parseAmount,
  type Amount,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { BankError } from '../errors.js';
import { accountForSpace, type SpaceService } from '../spaces/space-service.js';
import type { TransferService } from './transfer-service.js';
import { BookedTransferConflict } from './booked-transfer.js';
import { PartyHandleUnavailableError, type PartyHandlePort } from './party-handles.js';
import type { PersonalRequestNotices } from './request-notices.js';

const NOTE_MAX = 140;
const REFERENCE_MAX = 64;
/** A reserved send the client never retried. Older than this, and with no ledger posting, it stops counting toward the daily cap. */
const STALE_RESERVATION_MS = 15 * 60 * 1000;

export type RequestStatus = 'open' | 'paid' | 'declined' | 'cancelled' | 'expired';

export interface PersonalTransferView {
  readonly transferId: string;
  readonly ledgerTxId: string;
  readonly amount: string;
  readonly assetId: string;
  readonly note: string | null;
  readonly reference: string | null;
  readonly requestId: string | null;
  readonly fromHandle: string | null;
  readonly toHandle: string | null;
  readonly handlesBlocker: string | null;
  readonly fee: null;
  readonly status: 'posted';
  readonly createdAt: string;
}

export interface TransferQuote {
  readonly assetId: string;
  readonly amount: string;
  readonly perTransferLimit: string;
  readonly dailyLimit: string;
  readonly spentToday: string;
  readonly fee: string;
  readonly feeBlocker: 'bank.personal_transfer_fee_unwired' | null;
  readonly withinPerTransfer: boolean;
  readonly withinDaily: boolean;
}

export interface PersonalRequestView {
  readonly requestId: string;
  readonly payeeUserId: string;
  readonly payerUserId: string;
  readonly payeeHandle: string | null;
  readonly payerHandle: string | null;
  readonly assetId: string;
  readonly amount: string;
  readonly note: string | null;
  readonly expiresAt: string;
  readonly status: RequestStatus;
  readonly ledgerTxId: string | null;
  readonly createdAt: string;
  readonly notice: { readonly delivered: boolean; readonly blocker: string | null };
}

export interface TransferFact {
  readonly note: string | null;
  readonly reference: string | null;
  readonly counterpartyHandle: string | null;
}

interface TransferRow {
  transfer_id: string;
  ledger_tx_id: string | null;
  from_user_id: string;
  from_space_id: string;
  to_user_id: string;
  asset_id: string;
  amount: string;
  note: string | null;
  reference: string | null;
  from_handle: string | null;
  to_handle: string | null;
  request_id: string | null;
  status: 'reserved' | 'posted';
  created_at: Date;
}

interface RequestRow {
  id: string;
  idempotency_key: string;
  payee_user_id: string;
  payer_user_id: string;
  asset_id: string;
  amount: string;
  note: string | null;
  expires_at: Date;
  status: 'open' | 'paid' | 'declined' | 'cancelled';
  claim_transfer_id: string | null;
  ledger_tx_id: string | null;
  payee_handle: string | null;
  payer_handle: string | null;
  notice_blocker: string | null;
  created_at: Date;
}

interface TermsRow {
  per_transfer_limit: string;
  daily_limit: string;
  fee: string;
}

const REQUEST_COLS = `
  id, idempotency_key, payee_user_id, payer_user_id, asset_id, amount::text AS amount, note,
  expires_at, status, claim_transfer_id, ledger_tx_id, payee_handle, payer_handle, notice_blocker, created_at
`;

const TRANSFER_COLS = `
  transfer_id, ledger_tx_id, from_user_id, from_space_id, to_user_id, asset_id, amount::text AS amount, note, reference,
  from_handle, to_handle, request_id, status, created_at
`;

/** Plain text, trimmed. Blank becomes null. Control characters and over-long text are refused. */
export function plainNote(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const note = value.trim();
  if (note === '') return null;
  if ([...note].length > NOTE_MAX || /[\u0000-\u001F\u007F]/.test(note)) {
    throw new BankError(
      `A payment note is plain text up to ${NOTE_MAX} characters (bank.personal_note_invalid)`,
      'bank.personal_note_invalid',
    );
  }
  return note;
}

/** Printable ASCII, trimmed. Blank becomes null. Anything else is refused. */
export function plainReference(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const reference = value.trim();
  if (reference === '') return null;
  if (reference.length > REFERENCE_MAX || !/^[\x20-\x7E]+$/.test(reference)) {
    throw new BankError(
      `A payment reference is printable text up to ${REFERENCE_MAX} characters (bank.personal_reference_invalid)`,
      'bank.personal_reference_invalid',
    );
  }
  return reference;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function effectiveStatus(row: RequestRow, now: Date): RequestStatus {
  if (row.status === 'open' && row.expires_at.getTime() <= now.getTime()) return 'expired';
  return row.status;
}

export class PersonalPayService {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: Pick<LedgerClient, 'getTx' | 'getTxByKey' | 'balance'>,
    private readonly transfers: Pick<TransferService, 'transferToUser'>,
    private readonly spaces: Pick<SpaceService, 'get' | 'findPrimary'>,
    private readonly options: {
      handles?: PartyHandlePort;
      notices?: PersonalRequestNotices;
      now?: () => Date;
    } = {},
  ) {}

  private now(at?: Date): Date {
    return at ?? this.options.now?.() ?? new Date();
  }

  async send(input: {
    actorUserId: string;
    transferId: string;
    fromSpaceId: string;
    toUserId: string;
    amount: Amount;
    note?: string | null;
    reference?: string | null;
    requestId?: string | null;
    now?: Date;
  }): Promise<PersonalTransferView> {
    const now = this.now(input.now);
    const note = plainNote(input.note);
    const reference = plainReference(input.reference);
    const requestId = input.requestId ?? null;
    const toUserId = input.toUserId.trim();
    const from = await this.spaces.get(input.fromSpaceId);
    if (from.userId !== input.actorUserId) {
      throw new BankError('Not your space', 'bank.not_owner');
    }
    const instruction = {
      actorUserId: input.actorUserId,
      fromSpaceId: input.fromSpaceId,
      toUserId,
      assetId: from.assetId,
      amount: input.amount,
      note,
      reference,
      requestId,
    };

    await this.sweepStale(input.actorUserId, now);

    const reserved = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.actorUserId}), hashtext(${from.assetId}))`;
      const prior = await tx<TransferRow[]>`
        SELECT ${tx.unsafe(TRANSFER_COLS)} FROM bank.personal_transfers WHERE transfer_id = ${input.transferId}
      `;
      const existing = prior[0];
      if (existing) {
        if (!sameTransfer(existing, instruction)) {
          throw new BankError(
            `Transfer ${input.transferId} already exists on different terms (bank.personal_transfer_conflict)`,
            'bank.personal_transfer_conflict',
          );
        }
        return existing;
      }
      if (requestId)
        await this.claim(tx, {
          requestId,
          transferId: input.transferId,
          payerUserId: input.actorUserId,
          toUserId,
          assetId: from.assetId,
          amount: input.amount,
          now,
        });
      await this.assertWithinTerms(tx, input.actorUserId, from.assetId, input.amount, now);
      const handles = await this.snapshotHandles(input.actorUserId, toUserId);
      const inserted = await tx<TransferRow[]>`
        INSERT INTO bank.personal_transfers (
          transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, note, reference, from_handle, to_handle, request_id, status, created_at
        ) VALUES (
          ${input.transferId}, ${input.actorUserId}, ${input.fromSpaceId}, ${toUserId}, ${from.assetId},
          ${formatAmount(input.amount)}::numeric, ${note}, ${reference}, ${handles.from}, ${handles.to}, ${requestId}, 'reserved', ${now}
        )
        RETURNING ${tx.unsafe(TRANSFER_COLS)}
      `;
      return inserted[0]!;
    });

    if (reserved.status === 'posted' && reserved.ledger_tx_id) {
      if (reserved.request_id) await this.finishRequest(reserved.request_id, input.transferId, reserved.ledger_tx_id, now);
      return this.toTransferView(reserved);
    }

    let ledgerTxId: string;
    try {
      const posted = await this.transfers.transferToUser({
        transferId: input.transferId,
        fromSpaceId: input.fromSpaceId,
        toUserId,
        amount: input.amount,
        now,
        openRecipientBalance: true,
      });
      ledgerTxId = posted.ledgerTxId;
    } catch (err) {
      // A typed refusal proved this send did not post. Looking the key up would
      // adopt whatever else is booked under it, including an own-space move.
      if (isDefinitePersonalRefusal(err)) {
        await this.abandon(input.transferId, requestId);
        throw err;
      }
      // Timeout, network, or 5xx: the post may still land. Keep the reservation
      // and the request claim. Adopt the key only when its entries are this send.
      const already = await this.ledger.getTxByKey(bankTransferKey('p2p', input.transferId, 0));
      if (!already) throw err;
      if (!(await this.bookedSendMatches(already, input.fromSpaceId, toUserId, from.assetId, input.amount))) {
        throw new BankError(
          `Transfer ${input.transferId} is not this send (bank.personal_transfer_conflict)`,
          'bank.personal_transfer_conflict',
        );
      }
      ledgerTxId = already.id;
    }

    const posted = await this.sql<TransferRow[]>`
      UPDATE bank.personal_transfers
         SET status = 'posted', ledger_tx_id = ${ledgerTxId}
       WHERE transfer_id = ${input.transferId} AND status = 'reserved'
      RETURNING ${this.sql.unsafe(TRANSFER_COLS)}
    `;
    const row = posted[0] ?? (await this.mustTransfer(input.transferId));
    if (requestId) await this.finishRequest(requestId, input.transferId, ledgerTxId, now);
    return this.toTransferView(row);
  }

  async get(actorUserId: string, ledgerTxId: string): Promise<PersonalTransferView> {
    const rows = await this.sql<TransferRow[]>`
      SELECT ${this.sql.unsafe(TRANSFER_COLS)}
        FROM bank.personal_transfers
       WHERE ledger_tx_id = ${ledgerTxId} AND status = 'posted'
         AND (from_user_id = ${actorUserId} OR to_user_id = ${actorUserId})
    `;
    const row = rows[0];
    if (!row) {
      throw new BankError(`Transfer ${ledgerTxId} not found (bank.personal_transfer_not_found)`, 'bank.personal_transfer_not_found');
    }
    return this.toTransferView(row);
  }

  async quote(actorUserId: string, assetId: string, amount: Amount, at?: Date): Promise<TransferQuote> {
    const now = this.now(at);
    const terms = await this.terms(assetId);
    if (!terms) {
      throw new BankError(
        `No per-transfer limit, daily limit, or fee is published for ${assetId} (bank.personal_transfer_terms_unset)`,
        'bank.personal_transfer_terms_unset',
      );
    }
    const spent = await this.spentToday(this.sql, actorUserId, assetId, utcDayStart(now));
    const fee = parseAmount(terms.fee);
    // A compliance-approved grant replaces the published limit of its kind for this customer (BK-acct-04).
    const grants = await grantedLimits(this.sql, actorUserId, assetId);
    const per = grants.perTransfer ?? parseAmount(terms.per_transfer_limit);
    const daily = grants.daily ?? parseAmount(terms.daily_limit);
    return {
      assetId,
      amount: formatAmount(amount),
      perTransferLimit: formatAmount(per),
      dailyLimit: formatAmount(daily),
      spentToday: formatAmount(spent),
      fee: formatAmount(fee),
      feeBlocker: fee > 0n ? 'bank.personal_transfer_fee_unwired' : null,
      withinPerTransfer: amount <= per,
      withinDaily: spent + amount <= daily,
    };
  }

  async factsFor(userId: string, txIds: readonly string[]): Promise<ReadonlyMap<string, TransferFact>> {
    const out = new Map<string, TransferFact>();
    if (txIds.length === 0) return out;
    const rows = await this.sql<TransferRow[]>`
      SELECT ${this.sql.unsafe(TRANSFER_COLS)}
        FROM bank.personal_transfers
       WHERE status = 'posted' AND ledger_tx_id IN ${this.sql(txIds)}
         AND (from_user_id = ${userId} OR to_user_id = ${userId})
    `;
    for (const row of rows) {
      if (!row.ledger_tx_id) continue;
      const counterpartyHandle = row.from_user_id === userId ? row.to_handle : row.from_handle;
      out.set(row.ledger_tx_id, { note: row.note, reference: row.reference, counterpartyHandle });
    }
    return out;
  }

  async createRequest(input: {
    payeeUserId: string;
    payerUserId: string;
    assetId: string;
    amount: Amount;
    note?: string | null;
    expiresAt: Date;
    idempotencyKey: string;
    now?: Date;
  }): Promise<PersonalRequestView> {
    const now = this.now(input.now);
    const note = plainNote(input.note);
    if (input.payeeUserId === input.payerUserId) {
      throw new BankError('You cannot request money from yourself (bank.personal_request_self)', 'bank.personal_request_self');
    }
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new BankError('A request needs an expiry in the future (bank.personal_request_expired)', 'bank.personal_request_expired');
    }
    const prior = await this.requestByKey(input.payeeUserId, input.idempotencyKey);
    if (prior) {
      if (!sameRequest(prior, input, note)) {
        throw new BankError(
          `Request key ${input.idempotencyKey} was already used on different terms (bank.personal_request_conflict)`,
          'bank.personal_request_conflict',
        );
      }
      return this.toRequestView(prior, now, { delivered: prior.notice_blocker === null, blocker: prior.notice_blocker });
    }
    const space = await this.spaces.findPrimary(input.payeeUserId, input.assetId);
    if (!space) {
      throw new BankError('This recipient cannot receive payments', 'bank.recipient_cannot_receive');
    }
    const handles = await this.requireHandles(input.payeeUserId, input.payerUserId);
    const inserted = await this.sql<RequestRow[]>`
      INSERT INTO bank.personal_requests (
        idempotency_key, payee_user_id, payer_user_id, asset_id, amount, note, expires_at,
        status, payee_handle, payer_handle
      ) VALUES (
        ${input.idempotencyKey}, ${input.payeeUserId}, ${input.payerUserId}, ${input.assetId},
        ${formatAmount(input.amount)}::numeric, ${note}, ${input.expiresAt}, 'open', ${handles.payee}, ${handles.payer}
      )
      ON CONFLICT (payee_user_id, idempotency_key) DO NOTHING
      RETURNING ${this.sql.unsafe(REQUEST_COLS)}
    `;
    const row = inserted[0] ?? (await this.requestByKey(input.payeeUserId, input.idempotencyKey));
    if (!row) throw new BankError('Request disappeared after insert', 'bank.personal_request_not_found');
    if (!sameRequest(row, input, note)) {
      throw new BankError(
        `Request key ${input.idempotencyKey} was already used on different terms (bank.personal_request_conflict)`,
        'bank.personal_request_conflict',
      );
    }
    if (inserted[0]) {
      const notice = await this.publishCreated(row, 1);
      return this.toRequestView(row, now, notice);
    }
    return this.toRequestView(row, now, { delivered: row.notice_blocker === null, blocker: row.notice_blocker });
  }

  async listRequests(input: {
    actorUserId: string;
    direction: 'incoming' | 'outgoing';
    status?: RequestStatus;
    limit?: number;
    now?: Date;
  }): Promise<PersonalRequestView[]> {
    const limit = listLimit(input.limit);
    const now = this.now(input.now);
    const party =
      input.direction === 'incoming' ? this.sql`payer_user_id = ${input.actorUserId}` : this.sql`payee_user_id = ${input.actorUserId}`;
    const statusClause =
      input.status === undefined
        ? this.sql`TRUE`
        : input.status === 'expired'
          ? this.sql`status = 'open' AND expires_at <= ${now}`
          : input.status === 'open'
            ? this.sql`status = 'open' AND expires_at > ${now}`
            : this.sql`status = ${input.status}`;
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.sql.unsafe(REQUEST_COLS)}
        FROM bank.personal_requests
       WHERE ${party} AND ${statusClause}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return rows.map((row) => this.toRequestView(row, now, { delivered: row.notice_blocker === null, blocker: row.notice_blocker }));
  }

  async getRequest(actorUserId: string, requestId: string, at?: Date): Promise<PersonalRequestView> {
    const now = this.now(at);
    const row = await this.mustRequest(requestId);
    if (row.payee_user_id !== actorUserId && row.payer_user_id !== actorUserId) {
      throw new BankError(`Request ${requestId} not found (bank.personal_request_not_found)`, 'bank.personal_request_not_found');
    }
    return this.toRequestView(row, now, { delivered: row.notice_blocker === null, blocker: row.notice_blocker });
  }

  async cancelRequest(actorUserId: string, requestId: string, at?: Date): Promise<PersonalRequestView> {
    return this.closeRequest(actorUserId, requestId, 'payee', 'cancelled', at);
  }

  async declineRequest(actorUserId: string, requestId: string, at?: Date): Promise<PersonalRequestView> {
    return this.closeRequest(actorUserId, requestId, 'payer', 'declined', at);
  }

  async remindRequest(actorUserId: string, requestId: string, idempotencyKey: string, at?: Date): Promise<PersonalRequestView> {
    const now = this.now(at);
    const row = await this.mustRequest(requestId);
    this.assertParty(row, actorUserId, 'payee');
    const status = effectiveStatus(row, now);
    if (status !== 'open') this.throwClosed(status);
    if (row.claim_transfer_id) {
      throw new BankError(
        `Request ${requestId} has a payment in flight (bank.personal_request_claim_held)`,
        'bank.personal_request_claim_held',
      );
    }
    const claimed = await this.sql.begin(async (tx) => {
      const prior = await tx<Array<{ sequence: number; published_at: Date | null }>>`
        SELECT sequence, published_at FROM bank.personal_request_reminds
         WHERE request_id = ${requestId} AND idempotency_key = ${idempotencyKey}
      `;
      if (prior[0]) return prior[0];
      const next = await tx<Array<{ sequence: number }>>`
        SELECT COALESCE(MAX(sequence), 1) + 1 AS sequence
          FROM bank.personal_request_reminds WHERE request_id = ${requestId}
      `;
      const sequence = next[0]!.sequence;
      const inserted = await tx<Array<{ sequence: number; published_at: Date | null }>>`
        INSERT INTO bank.personal_request_reminds (request_id, idempotency_key, sequence)
        VALUES (${requestId}, ${idempotencyKey}, ${sequence})
        ON CONFLICT (request_id, idempotency_key) DO NOTHING
        RETURNING sequence, published_at
      `;
      return inserted[0] ?? prior[0] ?? { sequence, published_at: null };
    });
    if (claimed.published_at) {
      return this.toRequestView(row, now, { delivered: true, blocker: null });
    }
    const notice = await this.publishCreated(row, claimed.sequence);
    if (notice.delivered) {
      await this.sql`
        UPDATE bank.personal_request_reminds SET published_at = ${now}
         WHERE request_id = ${requestId} AND idempotency_key = ${idempotencyKey}
      `;
    }
    return this.toRequestView(row, now, notice);
  }

  private async closeRequest(
    actorUserId: string,
    requestId: string,
    party: 'payee' | 'payer',
    next: 'cancelled' | 'declined',
    at?: Date,
  ): Promise<PersonalRequestView> {
    const now = this.now(at);
    const row = await this.mustRequest(requestId);
    this.assertParty(row, actorUserId, party);
    if (row.status === next) return this.toRequestView(row, now, { delivered: row.notice_blocker === null, blocker: row.notice_blocker });
    const status = effectiveStatus(row, now);
    if (status !== 'open') this.throwClosed(status);
    if (row.claim_transfer_id) {
      throw new BankError(
        `Request ${requestId} has a payment in flight (bank.personal_request_claim_held)`,
        'bank.personal_request_claim_held',
      );
    }
    const updated = await this.sql<RequestRow[]>`
      UPDATE bank.personal_requests
         SET status = ${next}, updated_at = ${now}
       WHERE id = ${requestId} AND status = 'open' AND expires_at > ${now} AND claim_transfer_id IS NULL
      RETURNING ${this.sql.unsafe(REQUEST_COLS)}
    `;
    const saved = updated[0] ?? (await this.mustRequest(requestId));
    if (saved.status !== next) this.throwClosed(effectiveStatus(saved, now));
    return this.toRequestView(saved, now, { delivered: saved.notice_blocker === null, blocker: saved.notice_blocker });
  }

  private async claim(
    tx: TransactionSql,
    input: {
      requestId: string;
      transferId: string;
      payerUserId: string;
      toUserId: string;
      assetId: string;
      amount: Amount;
      now: Date;
    },
  ): Promise<void> {
    const updated = await tx<RequestRow[]>`
      UPDATE bank.personal_requests
         SET claim_transfer_id = ${input.transferId}, updated_at = ${input.now}
       WHERE id = ${input.requestId}
         AND payer_user_id = ${input.payerUserId}
         AND payee_user_id = ${input.toUserId}
         AND asset_id = ${input.assetId}
         AND amount = ${formatAmount(input.amount)}::numeric
         AND status = 'open'
         AND expires_at > ${input.now}
         AND (claim_transfer_id IS NULL OR claim_transfer_id = ${input.transferId})
      RETURNING ${tx.unsafe(REQUEST_COLS)}
    `;
    if (updated[0]) return;
    const rows = await tx<RequestRow[]>`
      SELECT ${tx.unsafe(REQUEST_COLS)} FROM bank.personal_requests WHERE id = ${input.requestId}
    `;
    const row = rows[0];
    if (!row || (row.payer_user_id !== input.payerUserId && row.payee_user_id !== input.payerUserId)) {
      throw new BankError(`Request ${input.requestId} not found (bank.personal_request_not_found)`, 'bank.personal_request_not_found');
    }
    if (row.payer_user_id !== input.payerUserId) {
      throw new BankError(
        `Only the person asked to pay can settle request ${input.requestId} (bank.personal_request_not_payer)`,
        'bank.personal_request_not_payer',
      );
    }
    if (row.payee_user_id !== input.toUserId) {
      throw new BankError(
        `Payment recipient is not the person who asked (bank.personal_request_payee_mismatch)`,
        'bank.personal_request_payee_mismatch',
      );
    }
    if (row.asset_id !== input.assetId || parseAmount(row.amount) !== input.amount) {
      throw new BankError(
        `Payment does not match request ${input.requestId} (bank.personal_request_amount_mismatch)`,
        'bank.personal_request_amount_mismatch',
      );
    }
    if (row.claim_transfer_id && row.claim_transfer_id !== input.transferId) {
      throw new BankError(
        `Request ${input.requestId} has a payment in flight (bank.personal_request_claim_held)`,
        'bank.personal_request_claim_held',
      );
    }
    const status = effectiveStatus(row, input.now);
    if (status === 'expired') {
      throw new BankError(`Request ${input.requestId} has expired (bank.personal_request_expired)`, 'bank.personal_request_expired');
    }
    this.throwClosed(status);
  }

  private async finishRequest(requestId: string, transferId: string, ledgerTxId: string, now: Date): Promise<void> {
    const updated = await this.sql<RequestRow[]>`
      UPDATE bank.personal_requests
         SET status = 'paid', ledger_tx_id = ${ledgerTxId}, updated_at = ${now}
       WHERE id = ${requestId} AND claim_transfer_id = ${transferId} AND status = 'open'
      RETURNING ${this.sql.unsafe(REQUEST_COLS)}
    `;
    const row = updated[0] ?? (await this.mustRequest(requestId));
    if (row.status !== 'paid') return;
    if (!row.payer_handle) return;
    const notices = this.options.notices;
    if (!notices) {
      await this.rememberNotice(requestId, 'bank.pay_request_notify_unwired');
      return;
    }
    try {
      await notices.paid({
        requestId,
        payeeUserId: row.payee_user_id,
        payerHandle: row.payer_handle,
        amount: formatAmount(parseAmount(row.amount)),
        assetId: row.asset_id,
        ledgerTxId,
      });
      await this.rememberNotice(requestId, null);
    } catch (err) {
      await this.rememberNotice(requestId, noticeBlocker(err));
    }
  }

  private async publishCreated(row: RequestRow, sequence: number): Promise<{ delivered: boolean; blocker: string | null }> {
    if (!row.payee_handle) {
      await this.rememberNotice(row.id, 'bank.party_handles_unset');
      return { delivered: false, blocker: 'bank.party_handles_unset' };
    }
    const notices = this.options.notices;
    if (!notices) {
      await this.rememberNotice(row.id, 'bank.pay_request_notify_unwired');
      return { delivered: false, blocker: 'bank.pay_request_notify_unwired' };
    }
    try {
      await notices.created({
        requestId: row.id,
        payerUserId: row.payer_user_id,
        payeeHandle: row.payee_handle,
        amount: formatAmount(parseAmount(row.amount)),
        assetId: row.asset_id,
        note: row.note,
        expiresAt: row.expires_at.toISOString(),
        sequence,
      });
      await this.rememberNotice(row.id, null);
      return { delivered: true, blocker: null };
    } catch (err) {
      const blocker = noticeBlocker(err);
      await this.rememberNotice(row.id, blocker);
      return { delivered: false, blocker };
    }
  }

  private async rememberNotice(requestId: string, blocker: string | null): Promise<void> {
    await this.sql`UPDATE bank.personal_requests SET notice_blocker = ${blocker} WHERE id = ${requestId}`;
  }

  private async assertWithinTerms(tx: TransactionSql, userId: string, assetId: string, amount: Amount, now: Date): Promise<void> {
    const rows = await tx<TermsRow[]>`
      SELECT per_transfer_limit::text, daily_limit::text, fee::text
        FROM bank.personal_transfer_terms WHERE asset_id = ${assetId}
    `;
    const terms = rows[0];
    if (!terms) return;
    const fee = parseAmount(terms.fee);
    if (fee > 0n) {
      throw new BankError(
        `A fee of ${formatAmount(fee)} ${assetId} is published, and this transfer has no fee leg to collect it (bank.personal_transfer_fee_unwired)`,
        'bank.personal_transfer_fee_unwired',
      );
    }
    const grants = await grantedLimits(tx, userId, assetId);
    const per = grants.perTransfer ?? parseAmount(terms.per_transfer_limit);
    if (amount > per) {
      throw new BankError(
        `Amount is above the per-transfer limit of ${formatAmount(per)} ${assetId} (bank.personal_transfer_limit_exceeded)`,
        'bank.personal_transfer_limit_exceeded',
      );
    }
    const spent = await this.spentToday(tx, userId, assetId, utcDayStart(now));
    const daily = grants.daily ?? parseAmount(terms.daily_limit);
    if (spent + amount > daily) {
      throw new BankError(
        `Amount would pass the daily limit of ${formatAmount(daily)} ${assetId} (bank.personal_transfer_daily_limit_exceeded)`,
        'bank.personal_transfer_daily_limit_exceeded',
      );
    }
  }

  private async terms(assetId: string): Promise<TermsRow | null> {
    const rows = await this.sql<TermsRow[]>`
      SELECT per_transfer_limit::text, daily_limit::text, fee::text
        FROM bank.personal_transfer_terms WHERE asset_id = ${assetId}
    `;
    return rows[0] ?? null;
  }

  private async spentToday(tx: Sql | TransactionSql, userId: string, assetId: string, start: Date): Promise<Amount> {
    const rows = await tx<Array<{ spent: string }>>`
      SELECT COALESCE(SUM(amount), 0)::text AS spent
        FROM bank.personal_transfers
       WHERE from_user_id = ${userId} AND asset_id = ${assetId} AND created_at >= ${start}
         AND status IN ('reserved', 'posted')
    `;
    return parseAmount(rows[0]?.spent ?? '0');
  }

  private async sweepStale(userId: string, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - STALE_RESERVATION_MS);
    const rows = await this.sql<
      Array<{
        transfer_id: string;
        request_id: string | null;
        from_space_id: string;
        to_user_id: string;
        asset_id: string;
        amount: string;
      }>
    >`
      SELECT transfer_id, request_id, from_space_id, to_user_id, asset_id, amount::text AS amount
        FROM bank.personal_transfers
       WHERE from_user_id = ${userId} AND status = 'reserved' AND created_at < ${cutoff}
    `;
    for (const row of rows) {
      const posted = await this.ledger.getTxByKey(bankTransferKey('p2p', row.transfer_id, 0));
      if (!posted) {
        await this.abandon(row.transfer_id, row.request_id);
        continue;
      }
      let matches = false;
      try {
        matches = await this.bookedSendMatches(posted, row.from_space_id, row.to_user_id, row.asset_id, parseAmount(row.amount));
      } catch (err) {
        this.logAdoptMismatch(row.transfer_id, row.request_id, posted.id, err);
        continue;
      }
      if (!matches) {
        this.logAdoptMismatch(row.transfer_id, row.request_id, posted.id);
        continue;
      }
      await this.sql`
        UPDATE bank.personal_transfers SET status = 'posted', ledger_tx_id = ${posted.id}
         WHERE transfer_id = ${row.transfer_id} AND status = 'reserved'
      `;
      if (row.request_id) await this.finishRequest(row.request_id, row.transfer_id, posted.id, now);
    }
  }

  /**
   * The booked transaction is this send only when it is the `bankTransfer` pair:
   * a credit of the sender's space (available falls) and a debit of the recipient's
   * primary space (available rises), same asset and amount, and no other leg.
   */
  private async bookedSendMatches(tx: LedgerTx, fromSpaceId: string, toUserId: string, assetId: string, amount: Amount): Promise<boolean> {
    if (tx.entries.length !== 2) return false;
    const from = await this.spaces.get(fromSpaceId);
    if (from.assetId !== assetId) return false;
    const dest = await this.spaces.findPrimary(toUserId, assetId);
    if (!dest) return false;
    const fromAccountId = (await this.ledger.balance(accountForSpace(from))).accountId;
    const toAccountId = (await this.ledger.balance(accountForSpace(dest))).accountId;
    if (fromAccountId === '' || toAccountId === '') return false;
    const credit = tx.entries.find(
      (entry) => entry.direction === 'credit' && entry.accountId === fromAccountId && entry.assetId === assetId && entry.amount === amount,
    );
    const debit = tx.entries.find(
      (entry) => entry.direction === 'debit' && entry.accountId === toAccountId && entry.assetId === assetId && entry.amount === amount,
    );
    return credit !== undefined && debit !== undefined;
  }

  private logAdoptMismatch(transferId: string, requestId: string | null, ledgerTxId: string, err?: unknown): void {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'svc-bank',
        event: 'bank.personal_transfer_adopt_mismatch',
        transferId,
        requestId,
        ledgerTxId,
        detail: err instanceof Error ? err.name : null,
      }),
    );
  }

  private async abandon(transferId: string, requestId: string | null): Promise<void> {
    await this.sql`DELETE FROM bank.personal_transfers WHERE transfer_id = ${transferId} AND status = 'reserved'`;
    if (!requestId) return;
    await this.sql`
      UPDATE bank.personal_requests SET claim_transfer_id = NULL
       WHERE id = ${requestId} AND claim_transfer_id = ${transferId} AND status = 'open'
    `;
  }

  private async snapshotHandles(fromUserId: string, toUserId: string): Promise<{ from: string | null; to: string | null }> {
    const port = this.options.handles;
    if (!port) return { from: null, to: null };
    try {
      const [from, to] = await Promise.all([port.handleOf(fromUserId), port.handleOf(toUserId)]);
      return { from, to };
    } catch (err) {
      if (err instanceof PartyHandleUnavailableError) return { from: null, to: null };
      throw err;
    }
  }

  private async requireHandles(payeeUserId: string, payerUserId: string): Promise<{ payee: string; payer: string }> {
    const port = this.options.handles;
    if (!port) {
      throw new BankError(
        'IDENTITY_URL is unset, so a request cannot name either person (bank.party_handles_unset)',
        'bank.party_handles_unset',
      );
    }
    let payee: string | null;
    let payer: string | null;
    try {
      [payee, payer] = await Promise.all([port.handleOf(payeeUserId), port.handleOf(payerUserId)]);
    } catch (err) {
      if (err instanceof PartyHandleUnavailableError) {
        throw new BankError(
          'Identity did not answer a handle lookup; the request was not created (bank.party_handles_unavailable)',
          'bank.party_handles_unavailable',
        );
      }
      throw err;
    }
    if (!payee) {
      throw new BankError('This recipient cannot receive payments', 'bank.recipient_cannot_receive');
    }
    if (!payer) {
      throw new BankError('No such person to ask (bank.personal_request_payer_unknown)', 'bank.personal_request_payer_unknown');
    }
    return { payee, payer };
  }

  private async requestByKey(payeeUserId: string, idempotencyKey: string): Promise<RequestRow | null> {
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.sql.unsafe(REQUEST_COLS)}
        FROM bank.personal_requests
       WHERE payee_user_id = ${payeeUserId} AND idempotency_key = ${idempotencyKey}
    `;
    return rows[0] ?? null;
  }

  private async mustRequest(requestId: string): Promise<RequestRow> {
    const rows = await this.sql<RequestRow[]>`
      SELECT ${this.sql.unsafe(REQUEST_COLS)} FROM bank.personal_requests WHERE id = ${requestId}
    `;
    const row = rows[0];
    if (!row) throw new BankError(`Request ${requestId} not found (bank.personal_request_not_found)`, 'bank.personal_request_not_found');
    return row;
  }

  private async mustTransfer(transferId: string): Promise<TransferRow> {
    const rows = await this.sql<TransferRow[]>`
      SELECT ${this.sql.unsafe(TRANSFER_COLS)} FROM bank.personal_transfers WHERE transfer_id = ${transferId}
    `;
    const row = rows[0];
    if (!row || !row.ledger_tx_id) {
      throw new BankError(`Transfer ${transferId} not found (bank.personal_transfer_not_found)`, 'bank.personal_transfer_not_found');
    }
    return row;
  }

  private assertParty(row: RequestRow, actorUserId: string, party: 'payee' | 'payer'): void {
    const owner = party === 'payee' ? row.payee_user_id : row.payer_user_id;
    if (owner === actorUserId) return;
    if (row.payee_user_id !== actorUserId && row.payer_user_id !== actorUserId) {
      throw new BankError(`Request ${row.id} not found (bank.personal_request_not_found)`, 'bank.personal_request_not_found');
    }
    const code = party === 'payee' ? 'bank.personal_request_not_payee' : 'bank.personal_request_not_payer';
    throw new BankError(`That action belongs to the ${party} (${code})`, code);
  }

  private throwClosed(status: RequestStatus): never {
    if (status === 'expired') {
      throw new BankError('The request has expired (bank.personal_request_expired)', 'bank.personal_request_expired');
    }
    throw new BankError(`The request is ${status} (bank.personal_request_closed)`, 'bank.personal_request_closed');
  }

  private async toTransferView(row: TransferRow): Promise<PersonalTransferView> {
    let createdAt = row.created_at;
    if (row.ledger_tx_id) {
      const tx = await this.ledger.getTx(row.ledger_tx_id);
      if (tx) createdAt = tx.postedAt;
    }
    const handlesMissing = row.from_handle === null || row.to_handle === null;
    return {
      transferId: row.transfer_id,
      ledgerTxId: row.ledger_tx_id ?? '',
      amount: formatAmount(parseAmount(row.amount)),
      assetId: row.asset_id,
      note: row.note,
      reference: row.reference,
      requestId: row.request_id,
      fromHandle: row.from_handle,
      toHandle: row.to_handle,
      handlesBlocker: handlesMissing ? (this.options.handles ? 'bank.party_handles_missing' : 'bank.party_handles_unset') : null,
      fee: null,
      status: 'posted',
      createdAt: createdAt.toISOString(),
    };
  }

  private toRequestView(row: RequestRow, now: Date, notice: { delivered: boolean; blocker: string | null }): PersonalRequestView {
    return {
      requestId: row.id,
      payeeUserId: row.payee_user_id,
      payerUserId: row.payer_user_id,
      payeeHandle: row.payee_handle,
      payerHandle: row.payer_handle,
      assetId: row.asset_id,
      amount: formatAmount(parseAmount(row.amount)),
      note: row.note,
      expiresAt: row.expires_at.toISOString(),
      status: effectiveStatus(row, now),
      ledgerTxId: row.ledger_tx_id,
      createdAt: row.created_at.toISOString(),
      notice,
    };
  }
}

function sameTransfer(
  row: TransferRow,
  input: {
    actorUserId: string;
    fromSpaceId: string;
    toUserId: string;
    assetId: string;
    amount: Amount;
    note: string | null;
    reference: string | null;
    requestId: string | null;
  },
): boolean {
  return (
    row.from_user_id === input.actorUserId &&
    row.from_space_id === input.fromSpaceId &&
    row.to_user_id === input.toUserId &&
    row.asset_id === input.assetId &&
    parseAmount(row.amount) === input.amount &&
    (row.note ?? null) === input.note &&
    (row.reference ?? null) === input.reference &&
    (row.request_id ?? null) === input.requestId
  );
}

/**
 * A BankError, or a failure that proves the ledger committed nothing under the key (`classifyPostOutcome`).
 * `ledger.idempotency_conflict` is NOT one: it proves the key already booked something. A timeout, a 5xx and
 * anything untyped may have committed. A `BookedTransferConflict` means the ledger answered with a movement that is
 * not this send, so it stays an unknown outcome too.
 */
function isDefinitePersonalRefusal(err: unknown): boolean {
  if (err instanceof BookedTransferConflict) return false;
  if (err instanceof BankError) return true;
  return provesPostNotCommitted(err);
}

function sameRequest(
  row: RequestRow,
  input: { payerUserId: string; assetId: string; amount: Amount; expiresAt: Date },
  note: string | null,
): boolean {
  return (
    row.payer_user_id === input.payerUserId &&
    row.asset_id === input.assetId &&
    parseAmount(row.amount) === input.amount &&
    (row.note ?? null) === note &&
    row.expires_at.getTime() === input.expiresAt.getTime()
  );
}

function listLimit(limit: number | undefined): number {
  if (limit === undefined) {
    throw new BankError(
      'personalRequest.list needs a limit from 1 to 100 (bank.personal_request_list_limit_unset)',
      'bank.personal_request_list_limit_unset',
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new BankError(
      'personalRequest.list needs a limit from 1 to 100 (bank.personal_request_list_limit_unset)',
      'bank.personal_request_list_limit_unset',
    );
  }
  return limit;
}

function noticeBlocker(err: unknown): string {
  if (err instanceof BankError) return err.code;
  return 'bank.pay_request_notify_failed';
}
