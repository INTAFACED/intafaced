/**
 * Tells the other person a payment request was created, reminded, or paid.
 *
 * The bus subjects are bank facts (`personal_request.created` / `.settled`).
 * svc-notify writes the inbox kinds `pay.request_created` and `pay.request_paid`.
 * Publishing is not a value movement.
 */
import type { EventBus } from '@intafaced/events';
import { BankError } from '../errors.js';

export interface RequestCreatedNotice {
  readonly requestId: string;
  readonly payerUserId: string;
  readonly payeeHandle: string;
  readonly amount: string;
  readonly assetId: string;
  readonly note: string | null;
  readonly expiresAt: string;
  /** 1 on create. 2 and up are reminds of the same open request. */
  readonly sequence: number;
}

export interface RequestPaidNotice {
  readonly requestId: string;
  readonly payeeUserId: string;
  readonly payerHandle: string;
  readonly amount: string;
  readonly assetId: string;
  readonly ledgerTxId: string;
}

export interface PersonalRequestNotices {
  created(input: RequestCreatedNotice): Promise<void>;
  paid(input: RequestPaidNotice): Promise<void>;
}

export function unwiredPersonalRequestNotices(): PersonalRequestNotices {
  const refuse = async () => {
    throw new BankError(
      'svc-notify is not wired for payment requests, so the other person was not told (bank.pay_request_notify_unwired)',
      'bank.pay_request_notify_unwired',
    );
  };
  return { created: refuse, paid: refuse };
}

export function eventPersonalRequestNotices(bus: EventBus): PersonalRequestNotices {
  return {
    async created(input) {
      await bus.publish(
        'personalRequestCreated',
        {
          requestId: input.requestId,
          payerUserId: input.payerUserId,
          payeeHandle: input.payeeHandle,
          amount: input.amount,
          assetId: input.assetId,
          note: input.note,
          expiresAt: input.expiresAt,
          sequence: input.sequence,
        },
        { idempotencyKey: `pay.request_created:${input.requestId}:${input.sequence}` },
      );
    },
    async paid(input) {
      await bus.publish(
        'personalRequestSettled',
        {
          requestId: input.requestId,
          payeeUserId: input.payeeUserId,
          payerHandle: input.payerHandle,
          amount: input.amount,
          assetId: input.assetId,
          ledgerTxId: input.ledgerTxId,
        },
        { idempotencyKey: `pay.request_paid:${input.requestId}` },
      );
    },
  };
}
