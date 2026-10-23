/**
 * Tells both people that a personal send posted (PP-send-request-18).
 *
 * The bus subject is the bank fact `personal_transfer.posted`; svc-notify writes
 * `pay.transfer_received` for the recipient and `pay.transfer_sent` for the
 * sender from that one event. Publishing is not a value movement: the send has
 * already posted, so a failed publish is logged and never fails the send.
 */
import type { EventBus } from '@intafaced/events';

export interface TransferPostedNotice {
  readonly transferId: string;
  readonly senderUserId: string;
  readonly recipientUserId: string;
  readonly amount: string;
  readonly assetId: string;
  readonly ledgerTxId: string;
  readonly postedAt: string;
}

export interface PersonalTransferNotices {
  posted(input: TransferPostedNotice): Promise<void>;
}

export function eventPersonalTransferNotices(bus: EventBus): PersonalTransferNotices {
  return {
    async posted(input) {
      await bus.publish(
        'personalTransferPosted',
        {
          transferId: input.transferId,
          senderUserId: input.senderUserId,
          recipientUserId: input.recipientUserId,
          amount: input.amount,
          assetId: input.assetId,
          ledgerTxId: input.ledgerTxId,
          postedAt: input.postedAt,
        },
        { idempotencyKey: `pay.transfer_posted:${input.transferId}` },
      );
    },
  };
}
