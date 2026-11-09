/**
 * Request categories and where each goes (SP-tickets-01).
 *
 * Browser safe: nothing here imports Node. A fraud report goes to compliance: it is grouped into the desk group the owner
 * names as it is made, and with none named or found it is refused rather than left on the open desk.
 */
import { z } from 'zod';

export const supportTicketCategorySchema = z.enum([
  'account',
  'trading',
  'deposit_withdraw',
  'phishing',
  'fraud_report',
  'other',
  'complaint',
  'bereavement',
]);
export type SupportTicketCategory = z.infer<typeof supportTicketCategorySchema>;

/**
 * Categories made only through their own guided form, never the general request form: a complaint
 * (`support.safety.complain`) and a bereavement report (`support.safety.reportBereavement`), each acknowledged once with
 * its reference (BK-safe-03). The general `support.create` refuses them with `support.category_guided`.
 */
export const SUPPORT_GUIDED_CATEGORIES = ['complaint', 'bereavement'] as const satisfies readonly SupportTicketCategory[];
export const SUPPORT_CATEGORY_GUIDED = 'support.category_guided';

/** A category the service does not offer is refused by name, not as a shape error (SP-tickets-01). */
export const SUPPORT_CATEGORY_UNKNOWN = 'support.category_unknown';
/** The owner has not named the desk group fraud reports go to: a fraud report is refused, never left on the open desk. */
export const SUPPORT_FRAUD_ROUTE_UNSET = 'support.fraud_route_unset';
/** The owner named a group the desk does not have. */
export const SUPPORT_FRAUD_ROUTE_MISSING = 'support.fraud_route_missing';
/** A fraud report is sent with a request key, so a retry after a lost answer finds it instead of making a second one. */
export const SUPPORT_FRAUD_REPORT_KEY_REQUIRED = 'support.fraud_report_key_required';

/**
 * Where a request of each category goes: the support desk, or compliance (a fraud report is grouped into the owner's
 * compliance group as it is made, so the desk reads it as that group's ticket: its members, its assignee and the roles the
 * owner lets read every group, `SUPPORT_ALL_GROUPS_ROLES`).
 */
export const SUPPORT_CATEGORY_ROUTES = {
  account: 'desk',
  trading: 'desk',
  deposit_withdraw: 'desk',
  phishing: 'desk',
  fraud_report: 'compliance',
  other: 'desk',
  complaint: 'desk',
  bereavement: 'desk',
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

/**
 * Pasted message headers on a phishing report (I-signin-sessions-27). The same
 * bound as `body`: a schema limit on text, not a product magnitude.
 */
export const SUPPORT_MESSAGE_HEADERS_MAX = 10_000;
/** An oversize paste of headers, refused with the cap (J-identity-13 #2); never cut short. */
export const SUPPORT_HEADERS_TOO_LONG = 'support.headers_too_long';
