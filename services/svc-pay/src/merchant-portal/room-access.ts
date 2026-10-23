import { MERCHANT_PORTAL_ROOMS, merchantRoomAccessSchema, type MerchantRoomAccess } from '@intafaced/contracts';
import { merchantNotFound } from '../merchant-ownership.js';
import { capabilityFlagsForSession, type MerchantPermission, type MerchantRole } from '../merchant-ops/roles.js';
import type { MerchantTeamRead } from '../merchant-team-read.js';
import { PayError, type PayService } from '../payment-service.js';
import { PortalError } from './errors.js';

/**
 * Room access for one business (M-adv-phantom-order-01).
 *
 * Every portal room is returned for every role. Open stays on. Every other
 * action names a suspended or closed account, then KYB that is not approved,
 * before the role table. The owner's own profile.manage is the exception:
 * that owner can submit the business profile before KYB is approved. An
 * admin's profile.manage still waits for approval. A pending account is not
 * inactive, except where the procedure refuses any status other than active:
 * payment links, subscription writes, and sending a payout (the same cut-off
 * as assertMerchantActive). Refund and a payout request do not use that
 * cut-off. An allowed refund or payout names step-up. Nothing here moves
 * money, and a missing KYB status is refused rather than treated as verified.
 */

export type RoomActionReason = 'role' | 'kyb' | 'step_up' | 'inactive' | 'session';

type MoneyAct = 'send' | 'request';

type ActionNeed =
  | { kind: 'open' }
  | { kind: 'permission'; permission: MerchantPermission }
  | { kind: 'owner'; activeAccount: boolean }
  | { kind: 'money'; money: 'refund' | 'payout'; act: MoneyAct };

type ActionDef = { id: string; need: ActionNeed };

const OPEN: ActionDef = { id: 'open', need: { kind: 'open' } };

const refund = (id = 'refund'): ActionDef => ({ id, need: { kind: 'money', money: 'refund', act: 'send' } });
const payoutRequest: ActionDef = { id: 'payout.request', need: { kind: 'money', money: 'payout', act: 'request' } };
const payoutSend: ActionDef = { id: 'payout.send', need: { kind: 'money', money: 'payout', act: 'send' } };
const subscriptionManage: ActionDef = { id: 'subscription.manage', need: { kind: 'owner', activeAccount: true } };
const linkCreate: ActionDef = { id: 'link.create', need: { kind: 'owner', activeAccount: true } };

const EXTRA: Partial<Record<(typeof MERCHANT_PORTAL_ROOMS)[number], readonly ActionDef[]>> = {
  subscriptions: [subscriptionManage],
  subscription: [subscriptionManage],
  'subscription-new': [subscriptionManage],
  settings: [{ id: 'profile.manage', need: { kind: 'permission', permission: 'profile.manage' } }],
  'developer-webhooks': [{ id: 'webhook.manage', need: { kind: 'permission', permission: 'webhooks.manage' } }],
  'developer-endpoint': [{ id: 'webhook.manage', need: { kind: 'permission', permission: 'webhooks.manage' } }],
  invoices: [{ id: 'invoice.create', need: { kind: 'permission', permission: 'invoices.write' } }],
  invoice: [{ id: 'invoice.create', need: { kind: 'permission', permission: 'invoices.write' } }],
  'invoice-new': [{ id: 'invoice.create', need: { kind: 'permission', permission: 'invoices.write' } }],
  'report-exports': [{ id: 'export.create', need: { kind: 'permission', permission: 'exports.create' } }],
  reports: [{ id: 'export.create', need: { kind: 'permission', permission: 'exports.create' } }],
  links: [linkCreate],
  'link-new': [linkCreate],
  link: [linkCreate],
  refunds: [refund()],
  'refund-new': [refund()],
  refund: [refund()],
  team: [{ id: 'team.manage', need: { kind: 'permission', permission: 'team.manage' } }],
  disputes: [{ id: 'dispute.respond', need: { kind: 'permission', permission: 'disputes.respond' } }],
  dispute: [{ id: 'dispute.respond', need: { kind: 'permission', permission: 'disputes.respond' } }],
  notifications: [{ id: 'notification.manage', need: { kind: 'permission', permission: 'notifications.manage' } }],
  payments: [refund()],
  payment: [refund()],
  payouts: [payoutRequest, payoutSend],
  payout: [payoutRequest, payoutSend],
  approvals: [{ id: 'payout.approve', need: { kind: 'permission', permission: 'payout.approve' } }],
  'payout-new': [payoutRequest, payoutSend],
  'checkout-settings': [{ id: 'checkout.save', need: { kind: 'owner', activeAccount: false } }],
};

export interface RoomAccessContext {
  role: MerchantRole;
  sessionInteractive: boolean;
  accountStatus: 'pending' | 'active' | 'suspended' | 'closed';
  kybStatus: 'none' | 'pending' | 'approved' | 'rejected';
}

export function decideRoomAction(ctx: RoomAccessContext, need: ActionNeed): { allowed: boolean; reason: RoomActionReason | null } {
  if (need.kind === 'open') return { allowed: true, reason: null };
  if (!ctx.sessionInteractive) return { allowed: false, reason: 'session' };
  // createPaymentLink, subscription writes, and payoutSettlement refuse any
  // status other than active before KYB, the same cut-off as assertMerchantActive.
  // Refund and a payout approval request do not. Other writes leave a pending
  // account in onboarding, and only a suspended or closed one is inactive.
  const requiresActive =
    (need.kind === 'owner' && need.activeAccount) || (need.kind === 'money' && need.money === 'payout' && need.act === 'send');
  const inactive = requiresActive ? ctx.accountStatus !== 'active' : ctx.accountStatus === 'suspended' || ctx.accountStatus === 'closed';
  if (inactive) return { allowed: false, reason: 'inactive' };
  const ownerProfile = need.kind === 'permission' && need.permission === 'profile.manage' && ctx.role === 'owner';
  if (ctx.kybStatus !== 'approved' && !ownerProfile) return { allowed: false, reason: 'kyb' };
  if (need.kind === 'permission') {
    const flags = capabilityFlagsForSession(ctx.role, true);
    return flags[need.permission] ? { allowed: true, reason: null } : { allowed: false, reason: 'role' };
  }
  if (need.kind === 'owner') {
    return ctx.role === 'owner' ? { allowed: true, reason: null } : { allowed: false, reason: 'role' };
  }
  if (need.money === 'refund' || need.act === 'send') {
    if (ctx.role !== 'owner') return { allowed: false, reason: 'role' };
    return { allowed: true, reason: 'step_up' };
  }
  const flags = capabilityFlagsForSession(ctx.role, true);
  const may = ctx.role === 'owner' || flags['payout.request'] || flags['payout.approve'];
  return may ? { allowed: true, reason: 'step_up' } : { allowed: false, reason: 'role' };
}

export function projectRoomAccess(ctx: RoomAccessContext & { merchantId: string }): MerchantRoomAccess {
  const rooms = MERCHANT_PORTAL_ROOMS.map((room) => ({
    room,
    actions: [OPEN, ...(EXTRA[room] ?? [])].map((action) => ({
      action: action.id,
      ...decideRoomAction(ctx, action.need),
    })),
  }));
  return merchantRoomAccessSchema.parse({
    merchantId: ctx.merchantId,
    role: ctx.role,
    kybStatus: ctx.kybStatus,
    accountStatus: ctx.accountStatus,
    sessionInteractive: ctx.sessionInteractive,
    rooms,
  });
}

export async function readRoomAccess(input: {
  pay: Pick<PayService, 'getMerchant'>;
  team: MerchantTeamRead;
  userId: string | undefined;
  interactive: boolean;
  merchantId: string;
}): Promise<MerchantRoomAccess> {
  const userId = input.userId?.trim() ?? '';
  if (!userId) throw new PortalError('pay.merchant_actor_required', 'bad_request');
  let merchant;
  try {
    merchant = await input.pay.getMerchant(input.merchantId);
  } catch (err) {
    if (err instanceof PayError && err.code === 'pay.merchant_not_found') throw err;
    throw err;
  }
  let role: MerchantRole;
  if (merchant.userId === userId) role = 'owner';
  else {
    const stored = await input.team.activeRole(userId, input.merchantId);
    if (!stored) throw merchantNotFound(input.merchantId);
    role = stored;
  }
  return projectRoomAccess({
    merchantId: merchant.id,
    role,
    sessionInteractive: input.interactive,
    accountStatus: merchant.status,
    kybStatus: merchant.kybStatus,
  });
}
