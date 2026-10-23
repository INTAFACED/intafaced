import {
  alertLedgerIdempotencyMismatch,
  bankTransferIdempotencyKey,
  IDEMPOTENCY_CONFLICT_CODE,
  legacyBankTransferKey,
  LedgerError,
  postedRequestMatches,
  recipes,
  BANK_TRANSFER_LANES,
  type BankTransferInput,
  type BankTransferLane,
  type LedgerClient,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { BankError, type BankErrorCode } from '../errors.js';

function reuseCode(lane: BankTransferLane): BankErrorCode {
  if (lane === 'business') return 'bank.business_request_conflict';
  if (lane === 'sched') return 'bank.schedule_conflict';
  return 'bank.personal_transfer_conflict';
}

/**
 * Post one bank transfer under its lane key.
 *
 * A client id is only the suffix. Another lane that already booked that suffix
 * is a refusal: personal pay must not treat an own-space move as payment.
 * A row booked before lanes existed is adopted only when its legs are this
 * request. A returned transaction that is not this request is
 * `ledger.idempotency_conflict` plus one alert line, never a success.
 */
export async function postBankTransfer(ledger: LedgerClient, input: BankTransferInput): Promise<LedgerTx> {
  const request = recipes.bankTransfer(input);
  for (const lane of BANK_TRANSFER_LANES) {
    if (lane === input.lane) continue;
    const foreignKey = bankTransferIdempotencyKey(lane, input.transferId, input.occurrence);
    const foreign = await ledger.getTxByKey(foreignKey);
    if (!foreign) continue;
    alertLedgerIdempotencyMismatch({
      idempotencyKey: foreignKey,
      module: request.module,
      reason: request.reason,
      ledgerTxId: foreign.id,
      detail: 'transfer id already booked by another operation',
    });
    throw new BankError(
      `Transfer ${input.transferId} was already used by another operation (${reuseCode(input.lane)})`,
      reuseCode(input.lane),
    );
  }

  const legacyKey = legacyBankTransferKey(input.transferId, input.occurrence);
  if (legacyKey !== request.idempotencyKey) {
    const legacy = await ledger.getTxByKey(legacyKey);
    if (legacy) {
      if (await postedRequestMatches(ledger, legacy, request)) return legacy;
      alertLedgerIdempotencyMismatch({
        idempotencyKey: legacyKey,
        module: request.module,
        reason: request.reason,
        ledgerTxId: legacy.id,
        detail: 'legacy key booked a different movement',
      });
      throw new LedgerError(
        `Idempotency key ${legacyKey} already booked a different movement`,
        IDEMPOTENCY_CONFLICT_CODE,
      );
    }
  }

  const tx = await ledger.post(request);
  if (await postedRequestMatches(ledger, tx, request)) return tx;
  alertLedgerIdempotencyMismatch({
    idempotencyKey: request.idempotencyKey,
    module: request.module,
    reason: request.reason,
    ledgerTxId: tx.id,
    detail: 'returned transaction does not match the request',
  });
  throw new LedgerError(
    `Idempotency key ${request.idempotencyKey} returned a different movement`,
    IDEMPOTENCY_CONFLICT_CODE,
  );
}

/** Lane or pre-lane row, and only when its legs are this request. */
export async function findMatchingBankTransfer(ledger: LedgerClient, input: BankTransferInput): Promise<LedgerTx | null> {
  const request = recipes.bankTransfer(input);
  const found = await findBankTransfer(ledger, input.lane, input.transferId, input.occurrence);
  if (!found) return null;
  return (await postedRequestMatches(ledger, found, request)) ? found : null;
}

/** Lane key, or the pre-lane key when that is the row a crash left behind. */
export async function findBankTransfer(
  ledger: Pick<LedgerClient, 'getTxByKey'>,
  lane: BankTransferLane,
  transferId: string,
  occurrence: number,
): Promise<LedgerTx | null> {
  const current = await ledger.getTxByKey(bankTransferIdempotencyKey(lane, transferId, occurrence));
  if (current) return current;
  return ledger.getTxByKey(legacyBankTransferKey(transferId, occurrence));
}

const ONE_OFF_LANES = ['own', 'p2p', 'personal', 'business', 'rail'] as const satisfies readonly BankTransferLane[];

/** True when any one-off lane, or the pre-lane key, already booked this id. */
export async function oneOffTransferBooked(
  ledger: { getTxByKey(key: string): Promise<{ id: string } | null> },
  transferId: string,
): Promise<boolean> {
  for (const lane of ONE_OFF_LANES) {
    if ((await ledger.getTxByKey(bankTransferIdempotencyKey(lane, transferId, 0))) !== null) return true;
  }
  return (await ledger.getTxByKey(legacyBankTransferKey(transferId, 0))) !== null;
}
