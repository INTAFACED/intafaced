import 'server-only';
import { supportCommentSchema, supportTicketEventSchema, supportTicketSchema } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { QUEUE_PAGE, readQueueResult } from './model';
import type { SupportQueueView, SupportTicketView } from './types';

/**
 * svc-support's operator desk, read and used as the signed-in founder.
 *
 * Every procedure here is `support:ops`. Founder sign-in does not carry that permission today, so svc-support will
 * refuse with 403 until identity grants it (admin-BACKEND-NEEDS.md); the desk then says exactly that. Claiming
 * assigns the ticket to the founder who pressed the button: svc-support takes the operator id from the verified
 * session, never from this console.
 */

const LABELS: PartLabels = {
  service: 'svc-support',
  forbiddenMessage:
    'svc-support did not accept your founder session. Every support desk action needs the support-staff permission (support:ops), and founder sign-in does not carry it yet.',
};

const arrayOf =
  <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) =>
  (raw: unknown): T[] | null => {
    if (!Array.isArray(raw)) return null;
    const out: T[] = [];
    for (const row of raw) {
      const parsed = schema.safeParse(row);
      if (!parsed.success) return null;
      out.push(parsed.data);
    }
    return out;
  };

export async function loadQueue(ctx: FounderCallContext, now: Date = new Date()): Promise<SupportQueueView> {
  const result = await founderCall(ctx, 'support', 'listQueue', 'GET', { limit: QUEUE_PAGE }, (raw) => readQueueResult(raw, QUEUE_PAGE));
  return { asOf: now.toISOString(), queue: partFrom(result, (d) => d, LABELS) };
}

export async function loadTicket(ctx: FounderCallContext, ticketId: string, now: Date = new Date()): Promise<SupportTicketView> {
  const [ticket, comments, events] = await Promise.all([
    founderCall(ctx, 'support', 'get', 'GET', { ticketId }, parseWith(supportTicketSchema)),
    founderCall(ctx, 'support', 'listComments', 'GET', { ticketId, limit: 100 }, arrayOf(supportCommentSchema)),
    founderCall(ctx, 'support', 'events', 'GET', { ticketId, limit: 100 }, arrayOf(supportTicketEventSchema)),
  ]);
  const detail = partFrom(
    ticket,
    (t) => ({
      ticket: t,
      comments: partFrom(comments, (c) => c, LABELS),
      events: partFrom(events, (e) => e, LABELS),
    }),
    LABELS,
  );
  return { asOf: now.toISOString(), detail };
}

export function claimTicket(
  ctx: FounderCallContext,
  ticketId: string,
): Promise<FounderCallResult<ReturnType<typeof supportTicketSchema.parse>>> {
  return founderCall(ctx, 'support', 'claim', 'POST', { ticketId }, parseWith(supportTicketSchema));
}
