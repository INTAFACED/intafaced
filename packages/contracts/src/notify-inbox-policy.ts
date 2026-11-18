import { z } from 'zod';
import { defineProcedure } from './procedure.js';

/**
 * `notify` `notify.inboxPolicy`: the owner's notification-centre values, the page size the inbox is listed by and the
 * bell's unread cap, each null with its typed code until the owner sets it, and how long rows are kept. Public: it holds
 * no person's data. Served by svc-notify (mounted from this record) and read by the customer app's bell and inbox
 * through this record (HM-notifications-01).
 */
export const NOTIFY_INBOX_POLICY = defineProcedure({
  name: 'notify.inboxPolicy',
  service: 'svc-notify',
  module: 'notify',
  transport: 'trpc',
  kind: 'query',
  path: 'notify.inboxPolicy',
  input: z.void(),
  output: z.object({
    pageSize: z.number().int().positive().nullable(),
    pageSizeUnsetCode: z.literal('notify.list_limit_unset').nullable(),
    unreadCap: z.number().int().positive().nullable(),
    unreadCapUnsetCode: z.literal('notify.unread_cap_unset').nullable(),
    retentionDays: z.number().int().positive().nullable(),
    retention: z.enum(['keeps_every_row', 'days']),
    inventsLimits: z.literal(false),
  }),
});
export type NotifyInboxPolicy = z.output<typeof NOTIFY_INBOX_POLICY.output>;
