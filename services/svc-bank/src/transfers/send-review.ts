/**
 * PERSONAL SEND REVIEW (PP-send-request-10, J-pay-01 #6): the owner's rule that holds a send to another person for a
 * review before any money moves.
 *
 * A held send is an instruction, not money. Nothing is taken from the sender and nothing is reserved while it waits
 * (as a global send on hold), so a held send can never strand funds: if it is rejected, nothing ever moved; if it is
 * released, the same transfer id goes through the normal send path, which checks the terms, the balance and the
 * recipient at that moment and posts once.
 *
 * The rule is `BANK_PERSONAL_SEND_REVIEW_JSON`: a review line per asset, `{"USDT":"500"}`. A send above its asset's
 * line is held, with the reason class `amount_over_review_line`. The person is told the class, never the line. Unset
 * means the owner has published no review rule, and sends are not held (today's behaviour); a malformed value refuses
 * boot.
 */
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

/** Why a send is held, as the customer is told it. One class today; the database check lists the same ones. */
export const SEND_REVIEW_REASONS = ['amount_over_review_line'] as const;
export type SendReviewReason = (typeof SEND_REVIEW_REASONS)[number];

/** The published review rule: per asset, the amount above which a send is held. */
export interface SendReviewRule {
  readonly lines: ReadonlyMap<string, Amount>;
}

const DECIMAL = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/;
const ASSET = /^[A-Z0-9]{1,16}$/;

/** `BANK_PERSONAL_SEND_REVIEW_JSON`, or null when unset. Anything malformed throws, so a bad rule never runs quietly. */
export function parseSendReviewRule(raw: string | undefined): SendReviewRule | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('BANK_PERSONAL_SEND_REVIEW_JSON is not JSON: write {"<asset>": "<amount>"}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('BANK_PERSONAL_SEND_REVIEW_JSON must be an object of {"<asset>": "<amount>"}');
  const lines = new Map<string, Amount>();
  for (const [asset, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ASSET.test(asset)) throw new Error(`BANK_PERSONAL_SEND_REVIEW_JSON names "${asset}", which is not an asset id`);
    if (typeof value !== 'string' || !DECIMAL.test(value))
      throw new Error(`BANK_PERSONAL_SEND_REVIEW_JSON line for ${asset} must be a decimal string`);
    const line = parseAmount(value);
    if (line <= 0n) throw new Error(`BANK_PERSONAL_SEND_REVIEW_JSON line for ${asset} must be above zero`);
    lines.set(asset, line);
  }
  if (lines.size === 0) throw new Error('BANK_PERSONAL_SEND_REVIEW_JSON names no asset; leave it unset for no review rule');
  return { lines };
}

/** Why this send must wait for a review, or null when the rule lets it go now. */
export function reviewReason(rule: SendReviewRule | null | undefined, assetId: string, amount: Amount): SendReviewReason | null {
  const line = rule?.lines.get(assetId.toUpperCase());
  if (line === undefined) return null;
  return amount > line ? 'amount_over_review_line' : null;
}

export type HeldSendStatus = 'in_review' | 'released' | 'rejected';

export interface SendReviewRow {
  transfer_id: string;
  from_user_id: string;
  from_space_id: string;
  to_user_id: string;
  asset_id: string;
  amount: string;
  note: string | null;
  reference: string | null;
  request_id: string | null;
  from_handle: string | null;
  to_handle: string | null;
  reason_class: SendReviewReason;
  status: HeldSendStatus;
  decided_by: string | null;
  ledger_tx_id: string | null;
  created_at: Date;
  decided_at: Date | null;
}

export const SEND_REVIEW_COLS = `
  transfer_id, from_user_id, from_space_id::text AS from_space_id, to_user_id, asset_id, amount::text AS amount, note,
  reference, request_id::text AS request_id, from_handle, to_handle, reason_class, status, decided_by, ledger_tx_id,
  created_at, decided_at
`;

/** A send the review rule holds, as its sender reads it. Never the rule's line, never who decided. */
export interface HeldSendView {
  readonly transferId: string;
  readonly status: HeldSendStatus;
  readonly reasonClass: SendReviewReason;
  readonly amount: string;
  readonly assetId: string;
  readonly note: string | null;
  readonly reference: string | null;
  readonly requestId: string | null;
  readonly toHandle: string | null;
  /** Set once released: the posted send's ledger transaction. */
  readonly ledgerTxId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export function heldSendView(row: SendReviewRow): HeldSendView {
  return {
    transferId: row.transfer_id,
    status: row.status,
    reasonClass: row.reason_class,
    amount: formatAmount(parseAmount(row.amount)),
    assetId: row.asset_id,
    note: row.note,
    reference: row.reference,
    requestId: row.request_id,
    toHandle: row.to_handle,
    ledgerTxId: row.ledger_tx_id,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

/** The held row is this same instruction (a retry), not a different send under the same transfer id. */
export function sameHeldSend(
  row: SendReviewRow,
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
 * The answer to a send the review holds, or held and then rejected. Nothing moved, so it is a refusal to the door that
 * asked; the code says which, and the message names the transfer id so the sender's screen can read `transfers.held`.
 */
export function heldRefusal(view: HeldSendView): BankError {
  return view.status === 'rejected'
    ? new BankError(
        `Payment ${view.transferId} was not sent: the review rejected it (bank.personal_send_rejected)`,
        'bank.personal_send_rejected',
      )
    : new BankError(
        `Payment ${view.transferId} is in review before it is sent; nothing has moved (bank.personal_send_in_review)`,
        'bank.personal_send_in_review',
      );
}
