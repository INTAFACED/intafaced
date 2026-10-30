import { z } from 'zod';
import { payMerchantIdSchema } from './merchant-control.js';
import { merchantPortalRoleSchema } from './merchant-portal.js';

/**
 * Rooms the business portal opens (M-adv-phantom-order-01).
 * The same ids as the customer registry. A room is never omitted for a role.
 */
export const MERCHANT_PORTAL_ROOMS = [
  'conversion',
  'conversion-new',
  'conversion-order',
  'subscriptions',
  'subscription',
  'subscription-new',
  'compliance',
  'settings',
  'settings-notifications',
  'developer-keys',
  'developer-signing',
  'developer-webhooks',
  'developer-endpoint',
  'developer-deliveries',
  'invoices',
  'invoice',
  'money',
  'money-activity',
  'money-top-up',
  'reports',
  'report-exports',
  'links',
  'link-new',
  'link',
  'refunds',
  'refund-new',
  'refund',
  'dashboard',
  'onboarding',
  'team',
  'disputes',
  'dispute',
  'customers',
  'customer',
  'notifications',
  'payments',
  'payment',
  'settlements',
  'settlement',
  'payouts',
  'payout',
  'approvals',
  'pricing',
  'limits',
  'payout-new',
  'payout-destinations',
  'network',
  'network-child',
  'permissions',
  'checkout-settings',
  'developer-sandbox',
  'developer-docs',
  'analytics',
  'analytics-fees',
  'settings-security',
  'activity',
  'invoice-new',
  'products',
  'product-new',
  'product-import',
  'product',
  'settings-stores',
] as const;

export const merchantPortalRoomSchema = z.enum(MERCHANT_PORTAL_ROOMS);

/** Why a control is off, or that an allowed money control still needs a step-up. */
export const merchantRoomActionReasonSchema = z.enum(['role', 'kyb', 'step_up', 'inactive', 'session']);

export const merchantRoomActionSchema = z
  .object({
    action: z.string().min(1).max(64),
    allowed: z.boolean(),
    reason: merchantRoomActionReasonSchema.nullable(),
  })
  .strict();

export const merchantRoomAccessSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    role: merchantPortalRoleSchema,
    kybStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
    accountStatus: z.enum(['pending', 'active', 'suspended', 'closed']),
    sessionInteractive: z.boolean(),
    rooms: z.array(
      z
        .object({
          room: merchantPortalRoomSchema,
          actions: z.array(merchantRoomActionSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type MerchantRoomAccess = z.infer<typeof merchantRoomAccessSchema>;
