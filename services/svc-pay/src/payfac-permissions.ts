import {
  DEFAULT_GRANTED_AREAS,
  PERMISSION_AREAS,
  SubMerchantError,
  type PermissionArea,
  type PermissionChangeInput,
  type PermissionEventRecord,
  type PermissionGrantRecord,
} from './submerchants.js';
import type { MerchantAreaFence } from './merchant-ownership.js';

/**
 * D26-P1-P2 — PayFac sub-merchant permissions product path.
 *
 * Trees + journal + `assertMerchantAreaAccess` already exist on tip. This module
 * is the **product map** those surfaces share: which gateway/REST procedure needs
 * which area, which areas move value, and which PayFac residuals are honest §13
 * (not inventable here).
 *
 * REST and tRPC both read this map. Do not inline a second vocabulary in
 * `router.ts` — a drifted string is a grant that does nothing.
 */

/** Areas that move value or control money-out. Never in DEFAULT_GRANTED_AREAS. */
export const MONEY_PERMISSION_AREAS = [
  'payment',
  'payment.refund',
  'settlement',
  'settlement.payout',
] as const satisfies readonly PermissionArea[];

export type MoneyPermissionArea = (typeof MONEY_PERMISSION_AREAS)[number];

/**
 * Tracker title still says "14 permission areas". The shipped vocabulary is
 * `PERMISSION_AREAS` in `submerchants.ts` — eleven surfaces this service has
 * today. This number is that list's length, not a second taxonomy and not a
 * product target. Padding to fourteen (or inventing `underwriting`) is refused
 * at typecheck; adding a real twelfth is a one-line change on `PERMISSION_AREAS`.
 */
export const SHIPPED_PAYFAC_AREA_COUNT = 11;

type _ShippedAreaCount = (typeof PERMISSION_AREAS)['length'];
const _pinShippedCount: _ShippedAreaCount extends typeof SHIPPED_PAYFAC_AREA_COUNT ? typeof SHIPPED_PAYFAC_AREA_COUNT : never =
  SHIPPED_PAYFAC_AREA_COUNT;
const _pinNotInventedFourteenth: _ShippedAreaCount extends 14 ? never : true = true;
const _pinNoUnderwritingArea: 'underwriting' extends PermissionArea ? never : true = true;
void _pinShippedCount;
void _pinNotInventedFourteenth;
void _pinNoUnderwritingArea;

/**
 * Gateway / public REST surface → required area.
 *
 * Hosted `checkout.open` is a public payer door (no principal) and is not here.
 * Webhook + permission REST stay REST-only; tRPC money/profile doors share the
 * same eleven areas — never a twelfth.
 */
export const PAYFAC_SURFACE_AREAS = {
  'rest.payments.read': 'payment',
  'rest.payments.list': 'payment',
  'rest.payments.create': 'payment',
  'rest.payments.authorize': 'payment',
  'rest.payments.capture': 'payment',
  'rest.payments.refund': 'payment.refund',
  'rest.payment-links.create': 'payment.link',
  'rest.payment-links.list': 'payment.link',
  'rest.payment-links.get': 'payment.link',
  'rest.payment-links.deactivate': 'payment.link',
  'rest.balances.read': 'merchant.profile',
  'rest.webhooks.write': 'webhook',
  'rest.webhooks.read': 'webhook',
  'rest.permissions.grant': 'permission',
  'rest.permissions.revoke': 'permission',
  'rest.permissions.list': 'permission',
  'rest.permissions.history': 'permission',
  'trpc.merchant.setPayoutDestination': 'settlement.payout',
  'trpc.merchant.submitKyb': 'kyb',
  'trpc.merchant.decideKybStub': 'kyb',
  'trpc.merchant.profile': 'checkout.profile',
  'trpc.merchant.checkoutSettings.get': 'checkout.profile',
  'trpc.merchant.createLink': 'payment.link',
  'trpc.merchant.listLinks': 'payment.link',
  'trpc.merchant.getLink': 'payment.link',
  'trpc.merchant.deactivateLink': 'payment.link',
  'trpc.merchant.balances': 'merchant.profile',
  'trpc.merchant.payoutDestinations.add': 'settlement.payout',
  'trpc.merchant.payoutDestinations.list': 'settlement.payout',
  'trpc.merchant.payoutDestinations.setDefault': 'settlement.payout',
  'trpc.merchant.payoutDestinations.remove': 'settlement.payout',
  'trpc.payment.create': 'payment',
  'trpc.fraud.enqueueReview': 'payment',
  'trpc.fraud.getDispute': 'payment',
  'trpc.payment.authorize': 'payment',
  'trpc.payment.capture': 'payment',
  'trpc.payment.refund': 'payment.refund',
  'trpc.payment.get': 'payment',
  'trpc.payment.list': 'payment',
  'trpc.payment.history': 'payment',
  'trpc.payment.refunds.list': 'payment',
  'trpc.payment.refunds.get': 'payment',
  'trpc.settlement.run': 'settlement',
  'trpc.settlement.payout': 'settlement.payout',
  'trpc.settlement.get': 'settlement',
  'trpc.settlement.list': 'settlement',
  'trpc.settlement.lifecycle': 'settlement',
  'trpc.settlement.release': 'settlement',
} as const satisfies Record<string, PermissionArea>;

export type PayfacSurface = keyof typeof PAYFAC_SURFACE_AREAS;

/**
 * Honest partial — buildable mechanics stop here until owner/commercial law.
 * Named so `pay.payfac` cannot be read as "full PayFac underwriting".
 */
export const PAYFAC_PERMISSION_SOCKETS = [
  {
    id: 'socket.payfac-settling-party-partner',
    residual:
      'settlingParty values other than "self" — settling a sub-merchant out of our account is acquiring (sponsor bank / BIN). Tracked as socket.psp-partners; code refuses non-self by name.',
  },
  {
    id: 'socket.payfac-split-fee-recipes',
    residual:
      'Platform fee vs sub-merchant proceeds ledger recipes — DIRECTION §8 / owner fee table. No invent splits; settleWindow already refuses missing feeBps rather than assuming zero.',
  },
] as const;

/** Narrow port REST uses when the boot path passes SubMerchantService as `trees`. */
export interface PayfacPermissionPort extends MerchantAreaFence {
  grantPermission(input: PermissionChangeInput): Promise<PermissionEventRecord>;
  revokePermission(input: PermissionChangeInput): Promise<PermissionEventRecord>;
  listPermissions(actorMerchantId: string, subjectMerchantId: string, limit?: number): Promise<PermissionGrantRecord[]>;
  permissionHistory(actorMerchantId: string, subjectMerchantId: string, limit?: number): Promise<PermissionEventRecord[]>;
}

export function isPayfacPermissionPort(value: unknown): value is PayfacPermissionPort {
  if (!value || typeof value !== 'object') return false;
  const v = value as PayfacPermissionPort;
  return (
    typeof v.assertHolds === 'function' &&
    typeof v.grantPermission === 'function' &&
    typeof v.revokePermission === 'function' &&
    typeof v.listPermissions === 'function' &&
    typeof v.permissionHistory === 'function'
  );
}

export function areaForSurface(surface: PayfacSurface): PermissionArea {
  return PAYFAC_SURFACE_AREAS[surface];
}

/** Every vocabulary area is either money-gated, visibility/default, or named elsewhere. */
export function permissionAreaCoverage(): {
  areas: readonly PermissionArea[];
  shippedCount: typeof SHIPPED_PAYFAC_AREA_COUNT;
  money: readonly MoneyPermissionArea[];
  defaults: readonly PermissionArea[];
  sockets: typeof PAYFAC_PERMISSION_SOCKETS;
} {
  return {
    areas: PERMISSION_AREAS,
    shippedCount: PERMISSION_AREAS.length,
    money: MONEY_PERMISSION_AREAS,
    defaults: DEFAULT_GRANTED_AREAS,
    sockets: PAYFAC_PERMISSION_SOCKETS,
  };
}

/**
 * Resolve the caller's merchant node from the principal. Never from the body —
 * same rule as `submerchant-router.ts` `actor()`.
 */
export async function resolveActorMerchantId(
  pay: { getMerchantByUserId(userId: string): Promise<{ id: string } | null> },
  principalUserId: string | undefined,
): Promise<string> {
  if (!principalUserId) {
    throw new SubMerchantError(
      'This account is not a merchant, so it holds no position in any sub-merchant tree.',
      'pay.submerchant_not_onboarded',
    );
  }
  const actor = await pay.getMerchantByUserId(principalUserId);
  if (!actor) {
    throw new SubMerchantError(
      'This account is not a merchant, so it holds no position in any sub-merchant tree.',
      'pay.submerchant_not_onboarded',
    );
  }
  return actor.id;
}
