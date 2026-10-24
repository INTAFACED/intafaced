/**
 * "Waiting for your reply" contract (SP-help-centre-01): what the help centre front door reads to show a signed-in
 * customer an Action required banner.
 *
 * Browser safe: nothing here imports Node. It is a count and one pointer, never a list, so it needs no page size, and it
 * carries no other ticket fact. The ticket itself (`supportTicketSchema`) still never carries `waitingOn`: this answers only
 * for the caller's own requests that the desk has handed back to them.
 */
import { z } from 'zod';

export const supportAwaitingMineSchema = z
  .object({
    /** The caller's own open requests whose next move is theirs. Zero is a real answer, not a missing one. */
    count: z.number().int().nonnegative(),
    /** The one that has waited longest, so the banner can link to it. Null exactly when the count is zero. */
    longestWaiting: z.object({ ticketId: z.string().guid(), since: z.string().datetime() }).strict().nullable(),
  })
  .strict()
  .refine((v) => (v.count === 0) === (v.longestWaiting === null), {
    message: 'support.awaiting: a count above zero names its longest-waiting request, and zero names none',
  });
export type SupportAwaitingMine = z.infer<typeof supportAwaitingMineSchema>;
