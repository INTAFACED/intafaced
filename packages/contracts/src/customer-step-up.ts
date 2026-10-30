/**
 * Customer step-up (the dialog that mints a stepUpApprovalId).
 *
 * The client names the door, the amount and the target, and the same strings it
 * will send on the bank call. Identity hashes them. svc-bank recomputes that
 * hash from its own input (`bankActionPayloadHash` in svc-bank) and consumes
 * the approval once. The two hashes are the same bytes: sha256 of
 * JSON `{actionType, fields}` with field keys sorted, prefixed `sha256:`.
 *
 * `actor` is not a client field. Identity sets it to the signed-in user id.
 */
import { createHash } from 'node:crypto';
import { SAME_PERSON_ACTION_TYPES, type SamePersonActionType } from './action-approval.js';
import {
  ANTI_PHISHING_STEP_UP_PURPOSE,
  ANTI_PHISHING_STEP_UP_SCOPE,
  SECURITY_LOCK_UNLOCK_STEP_UP_PURPOSE,
  SECURITY_LOCK_UNLOCK_STEP_UP_SCOPE,
} from './identity.js';
import { RECOVERY_KEY_STEP_UP_PURPOSE, RECOVERY_KEY_STEP_UP_SCOPE } from './identity-recovery.js';

/** How long the user has to answer the passkey or authenticator after begin. */
export const CUSTOMER_STEP_UP_CHALLENGE_TTL_SECONDS = 120;

const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A send's note as svc-bank `plainNote` keeps it: trimmed, not blank, plain text up to 140 characters. */
const sendNote = (value: string) =>
  value !== '' && value === value.trim() && [...value].length <= 140 && !/[\u0000-\u001F\u007F]/.test(value);
/** A payment reference as svc-bank `plainReference` keeps it: trimmed, not blank, printable ASCII up to 64. */
const sendReference = (value: string) => value !== '' && value === value.trim() && value.length <= 64 && /^[\x20-\x7E]+$/.test(value);

export type CustomerStepUpDoor = {
  readonly scope: SamePersonActionType;
  readonly purpose: string;
  /** Field names the client sends. `actor` is added by identity and is not here. */
  readonly clientFields: readonly string[];
  /**
   * Fields the bank door hashes only when they are set (a send's note, payment reference, or the request it settles),
   * each with the shape the bank accepts after its own normalising. Sent, a field must already be in that shape (so the
   * two hashes are the same bytes) and is hashed as sent; left out, it is not in the hash, exactly as svc-bank builds it.
   */
  readonly optionalFields?: Readonly<Record<string, (value: string) => boolean>>;
  readonly amountField?: string;
  readonly targetField?: string;
  /** When false, `target` may be omitted and the target field is the empty string. */
  readonly targetRequired: boolean;
  readonly emptyOk: readonly string[];
  readonly decimalFields: readonly string[];
  readonly fixed: Readonly<Record<string, string>>;
};

export const CUSTOMER_STEP_UP_DOORS: readonly CustomerStepUpDoor[] = [
  {
    scope: 'bank.step_up.transfers.toUser',
    purpose: 'transfers.toUser',
    clientFields: ['transferId', 'fromSpaceId', 'toUserId', 'assetId', 'amount'],
    // svc-bank toUserBinding: note, reference and requestId join the hash only when the send carries them.
    optionalFields: { note: sendNote, reference: sendReference, requestId: (value) => UUID_RE.test(value) },
    amountField: 'amount',
    targetField: 'toUserId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.transfers.create',
    purpose: 'transfers.create',
    clientFields: ['transferId', 'fromSpaceId', 'toSpaceId', 'assetId', 'amount'],
    // svc-bank createTransferBinding: note and reference join the hash only when the transfer carries them.
    optionalFields: { note: sendNote, reference: sendReference },
    amountField: 'amount',
    targetField: 'toSpaceId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.transfers.scheduleToUser',
    purpose: 'transfers.scheduleToUser',
    clientFields: ['scheduleId', 'fromSpaceId', 'toUserId', 'assetId', 'amount', 'cadence', 'startsAt', 'endsAt'],
    amountField: 'amount',
    targetField: 'toUserId',
    targetRequired: true,
    emptyOk: ['endsAt'],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.transfers.schedule',
    purpose: 'transfers.schedule',
    clientFields: ['scheduleId', 'fromSpaceId', 'toSpaceId', 'assetId', 'amount', 'cadence', 'startsAt', 'endsAt'],
    amountField: 'amount',
    targetField: 'toSpaceId',
    targetRequired: true,
    emptyOk: ['endsAt'],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.business.runPayroll',
    purpose: 'business.runPayroll',
    clientFields: ['payrollId', 'accountId', 'fromSpaceId', 'assetId', 'lines'],
    targetField: 'accountId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.business.proposeTransfer',
    purpose: 'business.proposeTransfer',
    clientFields: ['clientId', 'accountId', 'fromSpaceId', 'toSpaceId', 'assetId', 'amount'],
    amountField: 'amount',
    targetField: 'toSpaceId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.business.approve',
    purpose: 'business.approve',
    clientFields: ['approvalId'],
    targetField: 'approvalId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.business.addMember',
    purpose: 'business.addMember',
    clientFields: ['accountId', 'userId', 'role'],
    targetField: 'userId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.business.removeMember',
    purpose: 'business.removeMember',
    clientFields: ['accountId', 'userId', 'requestId'],
    targetField: 'userId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.business.setMemberRole',
    purpose: 'business.setMemberRole',
    clientFields: ['accountId', 'userId', 'role', 'requestId'],
    targetField: 'userId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.cards.unfreeze',
    purpose: 'cards.setStatus',
    clientFields: ['cardId', 'fromStatus', 'status'],
    targetField: 'cardId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: { status: 'active' },
  },
  {
    scope: 'bank.step_up.cards.issue',
    purpose: 'cards.issue',
    clientFields: ['cardId', 'assetId', 'settlementAssetId', 'cashbackBps', 'perAuthorizationLimit', 'cardType', 'shippingAddress'],
    amountField: 'perAuthorizationLimit',
    targetField: 'cardId',
    targetRequired: true,
    emptyOk: ['settlementAssetId', 'cashbackBps', 'shippingAddress'],
    decimalFields: ['perAuthorizationLimit'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.cards.setLimits',
    purpose: 'cards.setLimits',
    clientFields: ['cardId', 'commandId', 'perAuthorizationLimit', 'dailyLimit', 'monthlyLimit', 'cashLimit'],
    amountField: 'perAuthorizationLimit',
    targetField: 'cardId',
    targetRequired: true,
    // Omitted ceiling is ''; a cleared ceiling is the string "null" (see svc-bank limitField).
    emptyOk: ['dailyLimit', 'monthlyLimit', 'cashLimit'],
    decimalFields: ['perAuthorizationLimit'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.cards.reveal',
    purpose: 'cards.reveal',
    clientFields: ['cardId', 'revealId'],
    targetField: 'cardId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.cards.pinReveal',
    purpose: 'cards.pinReveal',
    clientFields: ['cardId', 'revealId'],
    targetField: 'cardId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.cards.pinSet',
    purpose: 'cards.pinSet',
    clientFields: ['cardId', 'commandId'],
    targetField: 'cardId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.ramps.offramp',
    purpose: 'ramps.offramp',
    clientFields: ['offrampId', 'assetId', 'amount', 'kind', 'destinationRef', 'clientRef'],
    amountField: 'amount',
    targetField: 'destinationRef',
    targetRequired: false,
    emptyOk: ['destinationRef'],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.ramps.setWithdrawDestination',
    purpose: 'ramps.setWithdrawDestination',
    clientFields: ['kind', 'ref'],
    targetField: 'ref',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    // svc-p2p takeStepUpPayloadHash: the reviewed ad, coin amount and method exactly as `trades.take` carries them; a
    // held quote joins the hash when the take names one. The order id is the take's idempotency key and is not hashed.
    scope: 'p2p.step_up.trades.take',
    purpose: 'trades.take',
    clientFields: ['offerId', 'amount', 'method'],
    optionalFields: { quoteId: (value) => UUID_RE.test(value) },
    amountField: 'amount',
    targetField: 'offerId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    // svc-p2p releaseStepUpPayloadHash: the order whose escrow goes to the buyer. Its coin, amount and buyer are fixed
    // at take and cannot change, so the order id names the whole release.
    scope: 'p2p.step_up.trades.confirmReceived',
    purpose: 'trades.confirmReceived',
    clientFields: ['tradeId'],
    targetField: 'tradeId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    // svc-p2p instrumentStepUpPayloadHash: the payment method (instrument), whether it is added, changed or removed, and
    // the digest of the details it saves (`p2pInstrumentDetailsDigest`; empty when the change sends none), so one
    // confirmation approves one account number. Identity never sees the details themselves.
    scope: 'p2p.step_up.instruments.change',
    purpose: 'instruments.change',
    clientFields: ['instrumentId', 'change', 'detailsDigest'],
    targetField: 'instrumentId',
    targetRequired: true,
    emptyOk: ['detailsDigest'],
    decimalFields: [],
    fixed: {},
  },
  {
    // svc-trade (CB-bots-05): one profit withdrawal from the caller's own grid bot. The request id is the business key
    // `bots.grid.withdraw:<botId>:<requestId>`, so one confirmation approves one withdrawal of one amount.
    scope: 'trade.step_up.bots.grid.withdrawProfit',
    purpose: 'bots.grid.withdrawProfit',
    clientFields: ['botId', 'requestId', 'asset', 'amount'],
    amountField: 'amount',
    targetField: 'botId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    // svc-trade (J-copy-bots-otc-03 #4): close every position of the caller's own copy follow and end it. The request id
    // is the business key `copy.flatten:<followId>:<requestId>`, so one confirmation approves one close-all of one follow.
    scope: 'trade.step_up.copy.flatten',
    purpose: 'copy.flatten',
    clientFields: ['followId', 'requestId'],
    targetField: 'followId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    // svc-token (MC-token-02, J-more-catalogue-10 #6): the founder who runs a two-founder governance role change proves a
    // fresh second factor for exactly that account, role (empty for a revoke) and role revision. One confirmation
    // approves one role move.
    scope: 'token.step_up.governance.setRole',
    purpose: 'governance.setRole',
    clientFields: ['userId', 'role', 'expectedRevision'],
    targetField: 'userId',
    targetRequired: true,
    emptyOk: ['role'],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'pay.step_up.payoutDestination.set',
    purpose: 'payoutDestination.set',
    clientFields: ['merchantId', 'railId', 'kind', 'ref'],
    targetField: 'ref',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'bank.step_up.bills.pay',
    purpose: 'bills.pay',
    clientFields: ['idempotencyKey', 'billerId', 'reference', 'fromSpaceId', 'assetId', 'amount'],
    amountField: 'amount',
    targetField: 'billerId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.bills.recurring',
    purpose: 'bills.recurring',
    clientFields: ['idempotencyKey', 'billerId', 'reference', 'fromSpaceId', 'assetId', 'amount', 'cadence', 'startsAt', 'endsAt'],
    amountField: 'amount',
    targetField: 'billerId',
    targetRequired: true,
    emptyOk: ['endsAt'],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'bank.step_up.global.send',
    purpose: 'global.send',
    clientFields: [
      'idempotencyKey',
      'fromSpaceId',
      'assetId',
      'amount',
      'toCurrency',
      'recipientId',
      'country',
      'deliveryMethod',
      'compliance',
    ],
    // svc-bank globalSendStepUp: the rate lock the customer confirmed joins the hash only when the send names one.
    optionalFields: { quoteId: (value) => UUID_RE.test(value) },
    amountField: 'amount',
    targetField: 'recipientId',
    targetRequired: true,
    emptyOk: ['compliance'],
    decimalFields: ['amount'],
    fixed: {},
  },
  {
    scope: 'identity.step_up.email_change',
    purpose: 'account.email.change',
    clientFields: ['newEmail'],
    targetField: 'newEmail',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.phone_change',
    purpose: 'account.phone.change',
    clientFields: ['newPhone'],
    targetField: 'newPhone',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.phone_remove',
    purpose: 'account.phone.remove',
    clientFields: ['phone'],
    targetField: 'phone',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.close_account',
    purpose: 'account.close',
    clientFields: ['intent', 'clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.passkey_add',
    purpose: 'account.passkey.add',
    clientFields: ['label', 'clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.passkey_remove',
    purpose: 'account.passkey.remove',
    clientFields: ['credentialId', 'clientRequestId'],
    targetField: 'credentialId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.passkey_rename',
    purpose: 'account.passkey.rename',
    clientFields: ['credentialId', 'label', 'clientRequestId'],
    targetField: 'credentialId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    // `purposes` is the sorted, comma-joined set (`money_out,security_change,signin`), empty for "every action".
    scope: 'identity.step_up.passkey_purposes',
    purpose: 'account.passkey.purposes',
    clientFields: ['credentialId', 'purposes', 'clientRequestId'],
    targetField: 'credentialId',
    targetRequired: true,
    emptyOk: ['purposes'],
    decimalFields: [],
    fixed: {},
  },
  {
    // `on` is `on` or `off`.
    scope: 'identity.step_up.passkey_second_step',
    purpose: 'account.passkey.secondStep',
    clientFields: ['on', 'clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.totp_replace',
    purpose: 'account.totp.replace',
    clientFields: ['clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.totp_disable',
    purpose: 'account.totp.disable',
    clientFields: ['clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.recovery_codes_regenerate',
    purpose: 'account.recoveryCodes.regenerate',
    clientFields: ['clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.password_change_with_second_factor',
    purpose: 'account.password.change',
    clientFields: ['clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.fund_password_set',
    purpose: 'account.fundPassword.set',
    clientFields: ['clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.limits_loosen',
    purpose: 'account.limits.loosen',
    clientFields: ['limitKey', 'newValue', 'clientRequestId'],
    targetField: 'limitKey',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.self_freeze_lift',
    purpose: 'account.selfFreeze.lift',
    clientFields: ['clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.trusted_device_remove',
    purpose: 'account.trustedDevice.remove',
    clientFields: ['deviceId', 'clientRequestId'],
    targetField: 'deviceId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.trusted_device_approve',
    purpose: 'account.trustedDevice.approve',
    clientFields: ['flowId'],
    targetField: 'flowId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.link_method',
    purpose: 'account.signinMethod.link',
    clientFields: ['method', 'clientRequestId'],
    targetField: 'method',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.unlink_method',
    purpose: 'account.signinMethod.unlink',
    clientFields: ['method', 'clientRequestId'],
    targetField: 'method',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: RECOVERY_KEY_STEP_UP_SCOPE,
    purpose: RECOVERY_KEY_STEP_UP_PURPOSE,
    // `change` is add, revoke or plan; `target` is the key's fingerprint, the key id, or `plan:<heir handle>:<threshold>`.
    clientFields: ['change', 'target', 'clientRequestId'],
    targetField: 'target',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.sub_account_delete',
    purpose: 'account.subAccount.delete',
    clientFields: ['subAccountId', 'clientRequestId'],
    targetField: 'subAccountId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: 'identity.step_up.sub_account_edit',
    purpose: 'account.subAccount.edit',
    // label and purpose are always both sent and hashed as sent (purpose '' clears it), never filled in from the row.
    clientFields: ['subAccountId', 'label', 'purpose', 'clientRequestId'],
    targetField: 'subAccountId',
    targetRequired: true,
    emptyOk: ['purpose'],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: ANTI_PHISHING_STEP_UP_SCOPE,
    purpose: ANTI_PHISHING_STEP_UP_PURPOSE,
    // The code is hashed with the request id and never named as the target: the challenge row keeps the target in the
    // clear, and a short code could be read back from a hash whose other inputs were all stored. '' clears the code.
    clientFields: ['code', 'clientRequestId'],
    targetRequired: false,
    emptyOk: ['code'],
    decimalFields: [],
    fixed: {},
  },
  {
    scope: SECURITY_LOCK_UNLOCK_STEP_UP_SCOPE,
    purpose: SECURITY_LOCK_UNLOCK_STEP_UP_PURPOSE,
    clientFields: ['clientRequestId'],
    targetField: 'clientRequestId',
    targetRequired: true,
    emptyOk: [],
    decimalFields: [],
    fixed: {},
  },
];

export function doorForScope(scope: string): CustomerStepUpDoor | undefined {
  return CUSTOMER_STEP_UP_DOORS.find((door) => door.scope === scope);
}

/**
 * Payroll lines, in the order svc-bank hashes them: pairs of `[toSpaceId, amount]`
 * sorted by space id, then by the amount string (character order, not numeric).
 */
export function canonicalPayrollLines(lines: ReadonlyArray<{ toSpaceId: string; amount: string }>): string {
  return JSON.stringify(
    lines
      .map((line) => [line.toSpaceId, line.amount] as const)
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1)),
  );
}

/** Byte-identical to svc-bank `bankActionPayloadHash`. */
export function customerStepUpPayloadHash(actionType: string, fields: Record<string, string>): string {
  const sortedCopy: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value !== undefined) sortedCopy[key] = value;
  }
  const payload = JSON.stringify({ actionType, fields: sortedCopy });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export type CustomerStepUpBeginInput = {
  readonly scope: string;
  readonly purpose: string;
  readonly amount?: string;
  readonly target?: string;
  readonly fields: Readonly<Record<string, string>>;
};

export type CustomerStepUpBindFailure =
  'step_up.unknown_scope' | 'step_up.purpose' | 'step_up.amount' | 'step_up.target' | 'step_up.fields';

export type CustomerStepUpBinding =
  | {
      readonly ok: true;
      readonly scope: SamePersonActionType;
      readonly purpose: string;
      readonly amount: string | null;
      readonly target: string | null;
      readonly payloadHash: string;
    }
  | { readonly ok: false; readonly code: CustomerStepUpBindFailure };

function fieldShapeOk(door: CustomerStepUpDoor, key: string, value: string): boolean {
  if (value.length > 4000) return false;
  if (value.length === 0) return door.emptyOk.includes(key);
  if (door.decimalFields.includes(key) && !AMOUNT_RE.test(value)) return false;
  if (key === 'cashbackBps') {
    if (!/^(?:0|[1-9]\d{0,4})$/.test(value)) return false;
    if (Number(value) > 10_000) return false;
  }
  const fixed = door.fixed[key];
  if (fixed !== undefined && value !== fixed) return false;
  return true;
}

/**
 * Bind a begin request to the signed-in user. `actor` is that user id.
 * The client cannot supply it. A mismatch is a refusal, not a rewrite.
 */
export function bindCustomerStepUp(actor: string, input: CustomerStepUpBeginInput): CustomerStepUpBinding {
  if (!(SAME_PERSON_ACTION_TYPES as readonly string[]).includes(input.scope)) {
    return { ok: false, code: 'step_up.unknown_scope' };
  }
  const door = doorForScope(input.scope);
  if (!door) return { ok: false, code: 'step_up.unknown_scope' };
  if (input.purpose !== door.purpose) return { ok: false, code: 'step_up.purpose' };

  const keys = Object.keys(input.fields);
  const optional = door.optionalFields ?? {};
  const sentOptional = keys.filter((key) => Object.hasOwn(optional, key));
  if (
    keys.includes('actor') ||
    keys.length !== door.clientFields.length + sentOptional.length ||
    door.clientFields.some((key) => !keys.includes(key))
  ) {
    return { ok: false, code: 'step_up.fields' };
  }
  for (const key of door.clientFields) {
    const value = input.fields[key];
    if (value === undefined || !fieldShapeOk(door, key, value)) return { ok: false, code: 'step_up.fields' };
  }
  // A padded, blank or over-long optional value would hash bytes the bank never hashes, so the approval could not be spent.
  for (const key of sentOptional) if (!optional[key]!(input.fields[key]!)) return { ok: false, code: 'step_up.fields' };

  if (door.amountField) {
    const sent = input.fields[door.amountField];
    if (input.amount === undefined || input.amount !== sent) return { ok: false, code: 'step_up.amount' };
  } else if (input.amount !== undefined) {
    return { ok: false, code: 'step_up.amount' };
  }

  if (door.targetField) {
    const sent = input.fields[door.targetField] ?? '';
    if (door.targetRequired) {
      if (input.target === undefined || input.target !== sent) return { ok: false, code: 'step_up.target' };
    } else if ((input.target ?? '') !== sent) {
      return { ok: false, code: 'step_up.target' };
    }
  } else if (input.target !== undefined) {
    return { ok: false, code: 'step_up.target' };
  }

  const fields: Record<string, string> = { actor };
  for (const key of door.clientFields) fields[key] = input.fields[key]!;
  for (const key of sentOptional) fields[key] = input.fields[key]!;
  return {
    ok: true,
    scope: door.scope,
    purpose: door.purpose,
    amount: input.amount ?? null,
    target: input.target ?? null,
    payloadHash: customerStepUpPayloadHash(door.scope, fields),
  };
}
