import { TRPCError } from '@trpc/server';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { SupportError } from './support-service.js';
import { userCopy } from './user-copy.js';
import { WITHDRAWAL_FREEZE_UNAVAILABLE } from './withdrawal-freeze.js';

/** A SupportError in its wire form: the status and the words each code is sent with. */
export function supportTrpcError(err: SupportError): TRPCError {
  const message = err.missingKey ? `${userCopy(err.code)} ${err.missingKey}` : userCopy(err.code);
  if (err.code === 'support.not_found' || err.code === 'support.claim.not_found') {
    return new TRPCError({ code: 'NOT_FOUND', message });
  }
  // Live chat (SP-chat-01).
  if (err.code.startsWith('support.chat_')) {
    if (err.code === 'support.chat_not_found') return new TRPCError({ code: 'NOT_FOUND', message });
    if (err.code === 'support.chat_rate_limited') return new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
    if (err.code === 'support.chat_already_accepted' || err.code === 'support.chat_message_conflict')
      return new TRPCError({ code: 'CONFLICT', message });
    if (err.code === 'support.chat_prechat_invalid') return new TRPCError({ code: 'BAD_REQUEST', message });
    return new TRPCError({ code: 'PRECONDITION_FAILED', message });
  }
  if (err.code === 'support.claim.already_claimed' || err.code === 'support.kb_revision_stale' || err.code === 'support.already_rated') {
    return new TRPCError({ code: 'CONFLICT', message });
  }
  if (
    err.code === 'support.claim.not_queueable' ||
    err.code === 'support.claim.invalid_operator' ||
    err.code === 'support.claim.queue_empty' ||
    // A lifecycle move that is not available from where the ticket is now,
    // and an escalation that cites nothing, are both "the state you are
    // asking from does not permit this" rather than a malformed request.
    err.code === 'support.transition_illegal' ||
    err.code === 'support.transition_same_status' ||
    err.code === 'support.case_file.ungrounded' ||
    err.code === 'support.case_file.empty_summary' ||
    // Closed is terminal — same family as illegal lifecycle moves.
    err.code === 'support.escalation.terminal' ||
    err.code === 'support.comment.terminal' ||
    err.code === 'support.kb.not_published' ||
    err.code === 'support.kb_version_unknown' ||
    err.code === 'support.identity_grounding_unwired' ||
    err.code === 'support.order.user_mismatch' ||
    // J-support-public-20 #1: not the customer's record, or its owner gave no answer; nothing was linked.
    err.code === 'support.link_record_not_owned' ||
    err.code === 'support.link_record_unverifiable' ||
    err.code === 'support.settle.refused' ||
    err.code === 'support.kb_review_required' ||
    // listQueue / listAll / listMine / listComments / events / listKb / searchKb page size unpublished. Blank is not 100.
    err.code === 'support.queue_list_limit_unset' ||
    err.code === 'support.list_all_limit_unset' ||
    err.code === 'support.list_mine_limit_unset' ||
    err.code === 'support.list_comments_limit_unset' ||
    err.code === 'support.list_attachments_limit_unset' ||
    err.code === 'support.list_events_limit_unset' ||
    err.code === 'support.list_kb_limit_unset' ||
    err.code === 'support.staff_bootstrap' ||
    err.code === 'support.heartbeat_window_unset' ||
    err.code === 'support.ticket_closed' ||
    err.code === 'support.follow_up_invalid' ||
    err.code === 'support.hold_reason_required' ||
    err.code === 'support.rating_window_invalid' ||
    err.code === 'support.release.not_queueable' ||
    err.code === 'support.assign.not_queueable' ||
    err.code === 'support.attachments_unconfigured' ||
    err.code === 'support.bulk_cap_unset' ||
    err.code === 'support.view_cap_unset' ||
    err.code === 'support.view_cap_reached' ||
    err.code === 'support.filter_invalid' ||
    err.code === 'support.sort_invalid' ||
    err.code === 'support.merge_not_allowed' ||
    err.code === 'support.merge_same_ticket' ||
    err.code === 'support.rate_status_refused' ||
    err.code === 'support.attachment_scan_refused' ||
    err.code === 'support.attachment_count_unset' ||
    err.code === 'support.attachment_scan_unknown' ||
    err.code === 'support.attachment_count_reached' ||
    err.code === 'support.attachment_too_large' ||
    err.code === 'support.feedback_rate_limit_unset' ||
    err.code === 'support.comment_cap_unset' ||
    err.code === 'support.comment_cap_reached' ||
    err.code === 'support.assistant_model_unset' ||
    err.code === 'support.kb_section_unknown' ||
    err.code === 'support.fraud_route_unset' ||
    err.code === 'support.fraud_route_missing' ||
    err.code === 'support.fraud_report_key_required' ||
    // The guest path (SP-tickets-01): a blank owner value, no sender, an expired link, an answer the sender did not give.
    err.code === 'support.guest_link_ttl_unset' ||
    err.code === 'support.guest_rate_limit_unset' ||
    err.code === 'support.guest_retention_unset' ||
    err.code === 'support.guest_address_key_unset' ||
    err.code === 'support.guest_link_expired' ||
    err.code === 'support.guest_delivery_unknown' ||
    err.code === 'support.category_unknown' ||
    err.code === 'vendor.email' ||
    err.code === WITHDRAWAL_FREEZE_UNAVAILABLE ||
    err.code.startsWith('guest.')
  ) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message });
  }
  if (err.code === 'support.guest_link_invalid') {
    return new TRPCError({ code: 'NOT_FOUND', message });
  }
  if (err.code === 'support.feedback_rate_exceeded' || err.code === 'support.guest_rate_limited') {
    return new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
  }
  if (
    err.code === 'support.not_lead' ||
    err.code === 'support.not_staff' ||
    err.code === 'support.release.not_assignee' ||
    err.code === 'support.view_not_owner'
  ) {
    return new TRPCError({ code: 'FORBIDDEN', message });
  }
  if (
    err.code === 'support.idempotency_conflict' ||
    err.code === 'support.view_revision_stale' ||
    err.code === 'support.stale_ticket' ||
    err.code === 'support.group_member_duplicate' ||
    err.code === 'support.group_name_taken'
  ) {
    return new TRPCError({ code: 'CONFLICT', message });
  }
  // The lookup's trail row did not land, so nothing was read (J-charts-desk-19 #1).
  if (err.code === 'support.charts_lookup_unaudited') return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message });
  if (err.code === 'support.release.not_found' || err.code === 'support.assign.not_found' || err.code === 'support.group_unknown') {
    return new TRPCError({ code: 'NOT_FOUND', message });
  }
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

/**
 * svc-support's one reader of its refusals for a door mounted from a record (`mountRecord`). A handler lets its
 * `SupportError` go, and it leaves in the wire form above; a refusal the handler already made (a `TRPCError` whose cause
 * names its code) leaves as made. Anything else is not a named refusal and leaves unchanged.
 */
export const supportRefusal: RefusalOf = (err) => {
  if (err instanceof SupportError) return { code: err.code, error: supportTrpcError(err) };
  if (!(err instanceof TRPCError)) return undefined;
  const cause: unknown = err.cause;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? { code, error: err } : undefined;
};
