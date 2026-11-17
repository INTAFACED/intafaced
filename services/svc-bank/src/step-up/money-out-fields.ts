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

/** A business-team payment (J-bank-19): the payee, type and amount the maker named, under its own id. */
export function teamProposeBinding(i: {
  actor: string;
  accountId: string;
  paymentId: string;
  payee: string;
  paymentType: string;
  amount: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.businessTeam.propose',
    operationKey: i.paymentId,
    fields: {
      actor: i.actor,
      accountId: i.accountId,
      paymentId: i.paymentId,
      payee: i.payee,
      paymentType: i.paymentType,
      amount: i.amount,
    },
  };
}

/** One approval of one business-team payment: its own action type, so a business transfer's approval never spends here. */
export function teamApproveBinding(i: { actor: string; paymentId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.businessTeam.approve',
    operationKey: `${i.paymentId}:${i.actor}`,
    fields: { actor: i.actor, paymentId: i.paymentId },
  };
}

/** An invite: who it is for and the role it grants. A blank email (a link invite) and the role not given are ''. */
export function teamInviteBinding(i: {
  actor: string;
  accountId: string;
  inviteId: string;
  email: string | null;
  role: string | null;
  roleId: string | null;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.businessTeam.invite',
    operationKey: i.inviteId,
    fields: {
      actor: i.actor,
      accountId: i.accountId,
      inviteId: i.inviteId,
      email: i.email ?? '',
      role: i.role ?? '',
      roleId: i.roleId ?? '',
    },
  };
}

/** Joining by an invite: bound to the sha256 of the link's secret, never the secret. */
export function teamAcceptInviteBinding(i: { actor: string; tokenHash: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.businessTeam.acceptInvite',
    operationKey: i.tokenHash,
    fields: { actor: i.actor, tokenHash: i.tokenHash },
  };
}

/** Giving a member a custom role, or taking it away ('' roleId). */
export function teamAssignRoleBinding(i: { actor: string; accountId: string; userId: string; roleId: string | null }): DoorBinding {
  return {
    actionType: 'bank.step_up.businessTeam.assignRole',
    operationKey: `${i.accountId}:${i.userId}:${i.roleId ?? ''}`,
    fields: { actor: i.actor, accountId: i.accountId, userId: i.userId, roleId: i.roleId ?? '' },
  };
}

/** Paying a business's bill (J-bank-20): the bill and the attempt's own id, and its day when scheduled ('' when paid now). */
export function billPayBinding(i: { actor: string; billId: string; paymentId: string; scheduledFor: string | null }): DoorBinding {
  return {
    actionType: 'bank.step_up.businessBills.pay',
    operationKey: i.paymentId,
    fields: { actor: i.actor, billId: i.billId, paymentId: i.paymentId, scheduledFor: i.scheduledFor ?? '' },
  };
}

/** Confirming a business's bulk payment run (J-bank-21 #2): the run's own id is its one partner instruction's key. */
export function bulkRunConfirmBinding(i: { actor: string; runId: string }): DoorBinding {
  return { actionType: 'bank.step_up.businessPayouts.confirmRun', operationKey: i.runId, fields: { actor: i.actor, runId: i.runId } };
}

/** Paying a business's contractor batch (J-bank-21 #4): the batch's own id and the account it pays from. */
export function contractorBatchBinding(i: { actor: string; accountId: string; batchId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.businessPayouts.payBatch',
    operationKey: i.batchId,
    fields: { actor: i.actor, accountId: i.accountId, batchId: i.batchId },
  };
}

/** Approving and paying a member's reimbursement claim (J-bank-22 #5): the claim's own id is its one partner move's key. */
export function reimbursementPayBinding(i: { actor: string; claimId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.businessCards.approveAndPay',
    operationKey: i.claimId,
    fields: { actor: i.actor, claimId: i.claimId },
  };
}

/**
 * A business statement reaching back past the partner's strong customer authentication age (J-bank-23 #3): one approval
 * for one export id over one exact period, which every format of that period's export may use.
 */
export function bookStatementBinding(i: { actor: string; accountId: string; exportId: string; from: string; to: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.businessBooks.exportStatement',
    operationKey: i.exportId,
    fields: { actor: i.actor, accountId: i.accountId, exportId: i.exportId, from: i.from, to: i.to },
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

/**
 * Activating a card that arrived (BK-cissue-04). One approval turns one card on: the card id is the whole operation, and a
 * second use of the same approval is refused, as unfreezing is.
 */
export function activateCardBinding(i: { actor: string; cardId: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.activate',
    operationKey: i.cardId,
    fields: { actor: i.actor, cardId: i.cardId },
  };
}

/** Ordering a card from the card room (BK-cissue-02/-03): the approval binds every term of the order. */
export function orderCardBinding(i: {
  actor: string;
  cardId: string;
  assetId: string;
  perAuthorizationLimit: string;
  cardType: 'virtual' | 'physical';
  country: string;
  termsVersion: string;
  usesAllowed: number | null | undefined;
  designId: string | undefined;
  deliverySpeed: string | undefined;
  shippingAddress: string;
}): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.order',
    operationKey: i.cardId,
    fields: {
      actor: i.actor,
      cardId: i.cardId,
      assetId: i.assetId,
      perAuthorizationLimit: i.perAuthorizationLimit,
      cardType: i.cardType,
      country: i.country.toUpperCase(),
      termsVersion: i.termsVersion,
      usesAllowed: i.usesAllowed == null ? '' : String(i.usesAllowed),
      designId: i.designId ?? '',
      deliverySpeed: i.deliverySpeed ?? '',
      shippingAddress: i.shippingAddress,
    },
  };
}

/** Changing an ordered card's delivery address (BK-cissue-03): binds the request and the new address, as the order did. */
export function updateCardShippingBinding(i: { actor: string; cardId: string; requestId: string; shippingAddress: string }): DoorBinding {
  return {
    actionType: 'bank.step_up.cards.updateShipping',
    operationKey: i.requestId,
    fields: { actor: i.actor, cardId: i.cardId, requestId: i.requestId, shippingAddress: i.shippingAddress },
  };
}
