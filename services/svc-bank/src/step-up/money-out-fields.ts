/**
 * The exact fields each money-out door binds into its step-up approval hash.
 *
 * Bank builds these from its own validated input, never from anything the client claims
 * about the payload. The client must hash the SAME strings (`bankActionPayloadHash`:
 * sha256 of JSON `{actionType, fields}` with keys sorted) to get an approval that matches.
 *
 * Amounts are the decimal string exactly as sent on the door. Every id that makes the
 * request idempotent (transferId, scheduleId, payrollId, clientId, cardId) is inside the hash,
 * so one approval authorises one operation, not "any transfer of 5 USDT".
 */
import type { SamePersonActionType } from '@intafaced/contracts';

export type DoorBinding = {
  readonly actionType: SamePersonActionType;
  readonly fields: Record<string, string>;
  readonly operationKey: string;
};

export function toUserBinding(i: {
  actor: string;
  transferId: string;
  fromSpaceId: string;
  toUserId: string;
  assetId: string;
  amount: string;
  /** Trimmed note. Omitted from the hash when there is no note, so older approvals still match. */
  note?: string;
  /** Payment reference. Omitted from the hash when absent, same rule as the note. */
  reference?: string;
  /** Set when this send settles a payment request. Omitted otherwise. */
  requestId?: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.transfers.toUser',
    operationKey: i.transferId,
    fields: {
      actor: i.actor,
      transferId: i.transferId,
      fromSpaceId: i.fromSpaceId,
      toUserId: i.toUserId,
      assetId: i.assetId,
      amount: i.amount,
      ...(i.note ? { note: i.note } : {}),
      ...(i.reference ? { reference: i.reference } : {}),
      ...(i.requestId ? { requestId: i.requestId } : {}),
    },
  };
}

export function createTransferBinding(i: {
  actor: string;
  transferId: string;
  fromSpaceId: string;
  toSpaceId: string;
  assetId: string;
  amount: string;
  note?: string;
  reference?: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.transfers.create',
    operationKey: i.transferId,
    fields: {
      actor: i.actor,
      transferId: i.transferId,
      fromSpaceId: i.fromSpaceId,
      toSpaceId: i.toSpaceId,
      assetId: i.assetId,
      amount: i.amount,
      ...(i.note ? { note: i.note } : {}),
      ...(i.reference ? { reference: i.reference } : {}),
    },
  };
}

type ScheduleCommon = {
  actor: string;
  scheduleId: string;
  fromSpaceId: string;
  assetId: string;
  amount: string;
  cadence: string;
  startsAt: string;
  endsAt: string | undefined;
};

export function scheduleToUserBinding(i: ScheduleCommon & { toUserId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.transfers.scheduleToUser',
    operationKey: i.scheduleId,
    fields: {
      actor: i.actor,
      scheduleId: i.scheduleId,
      fromSpaceId: i.fromSpaceId,
      toUserId: i.toUserId,
      assetId: i.assetId,
      amount: i.amount,
      cadence: i.cadence,
      startsAt: i.startsAt,
      endsAt: i.endsAt ?? '',
    },
  };
}

export function scheduleBinding(i: ScheduleCommon & { toSpaceId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.transfers.schedule',
    operationKey: i.scheduleId,
    fields: {
      actor: i.actor,
      scheduleId: i.scheduleId,
      fromSpaceId: i.fromSpaceId,
      toSpaceId: i.toSpaceId,
      assetId: i.assetId,
      amount: i.amount,
      cadence: i.cadence,
      startsAt: i.startsAt,
      endsAt: i.endsAt ?? '',
    },
  };
}

/**
 * An edit of a standing order to someone else's space asks for the same approval a new one would, over the terms the
 * order will have after the edit. The operation is the edit at the revision it read, so an approval spent on creating
 * the order (or on an earlier edit) is not replayed for this one.
 */
export function scheduleEditBinding(i: ScheduleCommon & { toSpaceId: string; revision: number }): DoorBinding {
  return { ...scheduleBinding(i), operationKey: `${i.scheduleId}:edit:${i.revision}` };
}

/** Lines sorted by (toSpaceId, amount) so the client's row order cannot split the hash. */
export function payrollLines(lines: ReadonlyArray<{ toSpaceId: string; amount: string }>): string {
  return JSON.stringify(
    lines
      .map((l) => [l.toSpaceId, l.amount] as const)
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1)),
  );
}

export function runPayrollBinding(i: {
  actor: string;
  payrollId: string;
  accountId: string;
  fromSpaceId: string;
  assetId: string;
  recipients: ReadonlyArray<{ toSpaceId: string; amount: string }>;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.business.runPayroll',
    operationKey: i.payrollId,
    fields: {
      actor: i.actor,
      payrollId: i.payrollId,
      accountId: i.accountId,
      fromSpaceId: i.fromSpaceId,
      assetId: i.assetId,
      lines: payrollLines(i.recipients),
    },
  };
}

export function proposeTransferBinding(i: {
  actor: string;
  clientId: string;
  accountId: string;
  fromSpaceId: string;
  toSpaceId: string;
  assetId: string;
  amount: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.business.proposeTransfer',
    operationKey: i.clientId,
    fields: {
      actor: i.actor,
      clientId: i.clientId,
      accountId: i.accountId,
      fromSpaceId: i.fromSpaceId,
      toSpaceId: i.toSpaceId,
      assetId: i.assetId,
      amount: i.amount,
    },
  };
}

export function approveBinding(i: { actor: string; approvalId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.business.approve',
    operationKey: i.approvalId,
    fields: { actor: i.actor, approvalId: i.approvalId },
  };
}

export function removeMemberBinding(i: { actor: string; accountId: string; userId: string; requestId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.business.removeMember',
    operationKey: i.requestId,
    fields: { actor: i.actor, accountId: i.accountId, userId: i.userId, requestId: i.requestId },
  };
}

export function setMemberRoleBinding(i: {
  actor: string;
  accountId: string;
  userId: string;
  role: string;
  requestId: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.business.setMemberRole',
    operationKey: i.requestId,
    fields: { actor: i.actor, accountId: i.accountId, userId: i.userId, role: i.role, requestId: i.requestId },
  };
}

export function addMemberBinding(i: { actor: string; accountId: string; userId: string; role: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.business.addMember',
    operationKey: `${i.accountId}:${i.userId}:${i.role}`,
    fields: { actor: i.actor, accountId: i.accountId, userId: i.userId, role: i.role },
  };
}

export function unfreezeCardBinding(i: { actor: string; cardId: string; fromStatus: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.unfreeze',
    operationKey: `${i.cardId}:${i.fromStatus}`,
    fields: { actor: i.actor, cardId: i.cardId, fromStatus: i.fromStatus, status: 'active' },
  };
}

export function issueCardBinding(i: {
  actor: string;
  cardId: string;
  assetId: string;
  settlementAssetId: string | undefined;
  cashbackBps: number | undefined;
  perAuthorizationLimit: string;
  cardType?: string;
  shippingAddress?: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.issue',
    operationKey: i.cardId,
    fields: {
      actor: i.actor,
      cardId: i.cardId,
      assetId: i.assetId,
      settlementAssetId: i.settlementAssetId ?? '',
      cashbackBps: i.cashbackBps === undefined ? '' : String(i.cashbackBps),
      perAuthorizationLimit: i.perAuthorizationLimit,
      cardType: i.cardType ?? 'virtual',
      shippingAddress: i.shippingAddress ?? '',
    },
  };
}

/**
 * Loosening a spending ceiling. The PIN is deliberately absent: a 4-digit secret
 * must not be recoverable from the stored payload hash.
 */
export function setCardLimitsBinding(i: {
  actor: string;
  cardId: string;
  commandId: string;
  perAuthorizationLimit: string;
  dailyLimit: string;
  monthlyLimit: string;
  cashLimit: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.setLimits',
    operationKey: i.commandId,
    fields: {
      actor: i.actor,
      cardId: i.cardId,
      commandId: i.commandId,
      perAuthorizationLimit: i.perAuthorizationLimit,
      dailyLimit: i.dailyLimit,
      monthlyLimit: i.monthlyLimit,
      cashLimit: i.cashLimit,
    },
  };
}

export function revealCardBinding(i: { actor: string; cardId: string; revealId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.reveal',
    operationKey: i.revealId,
    fields: { actor: i.actor, cardId: i.cardId, revealId: i.revealId },
  };
}

export function revealCardPinBinding(i: { actor: string; cardId: string; revealId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.pinReveal',
    operationKey: i.revealId,
    fields: { actor: i.actor, cardId: i.cardId, revealId: i.revealId },
  };
}

/** Binds the attempt, not the PIN. See `setCardLimitsBinding`. */
export function setCardPinBinding(i: { actor: string; cardId: string; commandId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.pinSet',
    operationKey: i.commandId,
    fields: { actor: i.actor, cardId: i.cardId, commandId: i.commandId },
  };
}
