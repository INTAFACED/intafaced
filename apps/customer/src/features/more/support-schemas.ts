import type { z } from 'zod';
import type { SupportKbArticle, SupportTicket, supportMyTicketPropertiesSchema } from '@intafaced/contracts/support';
import { SUPPORT_GUIDED_CATEGORIES, supportTicketCategorySchema } from '@intafaced/contracts/support-categories';

/** What the support service returns: its records' own replies (`@intafaced/contracts/support-customer-procedures`). */
export type Ticket = SupportTicket;
export type KbArticle = SupportKbArticle;

/** The categories the general request form offers: a scam report, a complaint and a bereavement report have their own forms (BK-safe-02, BK-safe-03). */
export const CATEGORY_VALUES = supportTicketCategorySchema.options.filter(
  (value) => !(SUPPORT_GUIDED_CATEGORIES as readonly string[]).includes(value),
);

/** The desk's priority and type the owner lets a customer read (SP-tickets-04); null when not shown. */
export type MyTicketProperties = z.infer<typeof supportMyTicketPropertiesSchema>;
