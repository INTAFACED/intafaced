import type { SamePersonActionType } from '@intafaced/contracts';
import { canonicalCompliance } from './global.js';

/**
 * Fields svc-bank hashes for a bill or global-send step-up.
 * `actor` is the signed-in user. The client hashes the same strings, without
 * sending `actor` itself (identity adds it). Amount is the decimal string on
 * the wire, not a reformatted one.
 */

export type StepUpFields = {
  readonly actionType: SamePersonActionType;
  readonly operationKey: string;
  readonly fields: Record<string, string>;
};

export function billPayStepUp(i: {
  actor: string;
  idempotencyKey: string;
  billerId: string;
  reference: string;
  fromSpaceId: string;
  assetId: string;
  amount: string;
}): StepUpFields {
  return {
    actionType: 'bank.step_up.bills.pay',
    operationKey: i.idempotencyKey,
    fields: {
      actor: i.actor,
      idempotencyKey: i.idempotencyKey,
      billerId: i.billerId,
      reference: i.reference,
      fromSpaceId: i.fromSpaceId,
      assetId: i.assetId,
      amount: i.amount,
    },
  };
}

export function billRecurringStepUp(i: {
  actor: string;
  idempotencyKey: string;
  billerId: string;
  reference: string;
  fromSpaceId: string;
  assetId: string;
  amount: string;
  cadence: string;
  startsAt: string;
  endsAt: string | undefined;
}): StepUpFields {
  return {
    actionType: 'bank.step_up.bills.recurring',
    operationKey: i.idempotencyKey,
    fields: {
      actor: i.actor,
      idempotencyKey: i.idempotencyKey,
      billerId: i.billerId,
      reference: i.reference,
      fromSpaceId: i.fromSpaceId,
      assetId: i.assetId,
      amount: i.amount,
      cadence: i.cadence,
      startsAt: i.startsAt,
      endsAt: i.endsAt ?? '',
    },
  };
}

export function globalSendStepUp(i: {
  actor: string;
  idempotencyKey: string;
  fromSpaceId: string;
  assetId: string;
  amount: string;
  toCurrency: string;
  recipientId: string;
  country: string;
  deliveryMethod: string;
  compliance: Readonly<Record<string, string>> | undefined;
  quoteId: string | undefined;
}): StepUpFields {
  return {
    actionType: 'bank.step_up.global.send',
    operationKey: i.idempotencyKey,
    fields: {
      actor: i.actor,
      idempotencyKey: i.idempotencyKey,
      fromSpaceId: i.fromSpaceId,
      assetId: i.assetId,
      amount: i.amount,
      toCurrency: i.toCurrency,
      recipientId: i.recipientId,
      country: i.country,
      deliveryMethod: i.deliveryMethod,
      compliance: canonicalCompliance(i.compliance),
      // The rate lock the customer confirmed joins the hash only when the send names one (`optionalFields` in contracts).
      ...(i.quoteId !== undefined ? { quoteId: i.quoteId } : {}),
    },
  };
}
