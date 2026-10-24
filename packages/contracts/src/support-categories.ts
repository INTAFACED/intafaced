/**
 * Request categories and where each goes (SP-tickets-01).
 *
 * Browser safe: nothing here imports Node. A fraud report goes to compliance: it is grouped into the desk group the owner
 * names as it is made, and with none named or found it is refused rather than left on the open desk.
 */
import { z } from 'zod';

export const supportTicketCategorySchema = z.enum(['account', 'trading', 'deposit_withdraw', 'phishing', 'fraud_report', 'other']);
export type SupportTicketCategory = z.infer<typeof supportTicketCategorySchema>;

/** A category the service does not offer is refused by name, not as a shape error (SP-tickets-01). */
export const SUPPORT_CATEGORY_UNKNOWN = 'support.category_unknown';
/** The owner has not named the desk group fraud reports go to: a fraud report is refused, never left on the open desk. */
export const SUPPORT_FRAUD_ROUTE_UNSET = 'support.fraud_route_unset';
/** The owner named a group the desk does not have. */
export const SUPPORT_FRAUD_ROUTE_MISSING = 'support.fraud_route_missing';

/**
 * Where a request of each category goes: the support desk, or compliance (a fraud report is grouped into the owner's
 * compliance group as it is made, so only that group and the desk's leads read it).
 */
export const SUPPORT_CATEGORY_ROUTES = {
  account: 'desk',
  trading: 'desk',
  deposit_withdraw: 'desk',
  phishing: 'desk',
  fraud_report: 'compliance',
  other: 'desk',
} as const satisfies Record<SupportTicketCategory, 'desk' | 'compliance'>;

/** The categories a signed-in person can send, each with where it goes and, when it cannot be sent now, the refusal. */
export const supportCategoriesSchema = z.object({
  categories: z.array(
    z.object({
      id: supportTicketCategorySchema,
      routesTo: z.enum(['desk', 'compliance']),
      refusal: z.enum([SUPPORT_FRAUD_ROUTE_UNSET, SUPPORT_FRAUD_ROUTE_MISSING]).nullable(),
    }),
  ),
});
export type SupportCategories = z.infer<typeof supportCategoriesSchema>;
