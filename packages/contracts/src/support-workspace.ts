/**
 * Support request workspace codes (SP-tickets-09): what svc-support answers when an agent's write on a request is refused
 * because the request moved on, or the agent may not change who holds it.
 *
 * Browser safe: nothing here imports Node.
 *
 * - `support.stale_ticket`: a reply, status change or property change named an older trail row than the latest one written
 *   by someone else. Nothing is written; the refusal carries the newer rows. A repeated reply request id answers its stored
 *   reply before this check.
 * - `support.claim.queue_empty`: claim-next found no request to take. New here: the slice names no code for it.
 * - `support.release.not_assignee`: only the person holding a request may unclaim it.
 * - `support.not_lead`: only a lead gives a request to someone else.
 * - `support.not_staff`: a request is only given to a staff member.
 */
import { z } from 'zod';

export const SUPPORT_WORKSPACE_ERROR_CODES = [
  'support.stale_ticket',
  'support.claim.queue_empty',
  'support.release.not_assignee',
  'support.not_lead',
  'support.not_staff',
] as const;
export type SupportWorkspaceErrorCode = (typeof SUPPORT_WORKSPACE_ERROR_CODES)[number];
export const supportWorkspaceErrorCodeSchema = z.enum(SUPPORT_WORKSPACE_ERROR_CODES);

/** The trail row a write was read against. A write naming an older one than someone else's latest is refused as stale. */
export const supportExpectedSequenceSchema = z.number().int().nonnegative();
