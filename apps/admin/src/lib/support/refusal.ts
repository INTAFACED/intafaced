import type { FounderCallFailure } from '@/lib/desk/founder-call';
import { explainRefusal, type RefusalView } from '@/lib/desk/refusal-copy';

/**
 * Plain-English answers for what svc-support says back to a founder acting on a ticket or an article.
 *
 * svc-support names a refusal with a dotted code (`support.transition_illegal`) in the message of its answer. This turns
 * each code the desk can receive into a title, what it means and what to do next, and says whether anything changed.
 * A refusal this file does not know falls through to the general answers in `explainRefusal`, never to a raw code.
 */

/** The sentence a founder reads when svc-support says the session lacks the support permission. Said the same everywhere. */
export const SUPPORT_OPS_FORBIDDEN = 'Your console session does not have support operations permission';

export const SUPPORT_OPS_FORBIDDEN_BODY =
  'svc-support checks the support-staff permission (support:ops) itself and refused. Founder sign-in does not carry it today; granting it is pending in identity.';

interface Entry {
  readonly title: string;
  readonly body: string;
  readonly next: string;
}

const BY_SUPPORT_CODE: Readonly<Record<string, Entry>> = {
  'support.not_found': {
    title: 'No such ticket',
    body: 'svc-support does not have that ticket.',
    next: 'Go back to the queue and open the ticket again.',
  },
  'support.transition_same_status': {
    title: 'The ticket is already in that status',
    body: 'Nothing needed to change.',
    next: 'Read the ticket to see where it is now.',
  },
  'support.transition_illegal': {
    title: 'svc-support does not allow that status change',
    body: 'Open, pending and on-hold tickets can move to any other status except themselves. A resolved ticket can reopen or close. A closed ticket stays closed.',
    next: 'Pick a status the page offers, or read the ticket to see where it is now.',
  },
  'support.hold_reason_required': {
    title: 'Say why the request is on hold',
    body: 'A request is only put on hold with a reason. The customer sees it in their history.',
    next: 'Write the reason and send again. Nothing was changed.',
  },
  'support.comment_stale': {
    title: 'This request changed since you opened it',
    body: 'Someone else changed it after you read it, so your reply was not sent. The changes are listed here and in its history.',
    next: 'Read them, press "I have read the changes", then send again. Your draft is kept.',
  },
  'support.comment.terminal': {
    title: 'This ticket is closed',
    body: 'A closed ticket takes no more replies.',
    next: 'If the customer needs more help, they start a new request.',
  },
  'support.escalation.terminal': {
    title: 'A closed ticket cannot be escalated',
    body: 'A finished ticket stays finished.',
    next: 'Nothing was changed.',
  },
  'support.case_file.ungrounded': {
    title: 'The escalation cites nothing that was read',
    body: 'svc-support only escalates with proof of what was read: the customer’s account state, their comments, or an article you cite. None of those could be read here.',
    next: 'Read the ticket and check that identity is connected, then try again.',
  },
  'support.case_file.empty_summary': {
    title: 'The summary is empty',
    body: 'The case file keeps what you concluded, so it cannot be blank.',
    next: 'Write the summary and try again.',
  },
  'support.order.user_mismatch': {
    title: "That order is a different customer's",
    body: 'The desk only shows an order when it belongs to the customer on this ticket. This one does not, so the status was not shown.',
    next: 'Nothing was changed. The order was not cancelled.',
  },
  'support.identity_grounding_unwired': {
    title: 'The support desk cannot read account state',
    body: 'svc-support is not connected to identity on this deployment, so it will not escalate without reading the account.',
    next: 'Nothing was changed. Ask engineering to connect it.',
  },
  'support.settle.refused': {
    title: 'svc-support will not do that to a money request',
    body: 'A ticket escalated as a money request cannot be settled or closed from support. A support channel never moves money.',
    next: 'Nothing was changed. The money team owns this one.',
  },
  'support.not_staff': {
    title: 'You are not on the support staff list',
    body: 'svc-support only lets people on its staff list set availability. Your sign-in has the support permission, but nobody has appointed you.',
    next: 'Nothing was changed. A lead appoints staff.',
  },
  'support.bulk_cap_unset': {
    title: 'The batch size is not set',
    body: 'The owner has not set how many requests can change at once (support.bulk_cap), so svc-support refuses bulk changes rather than guess a number.',
    next: 'Nothing was changed. Change one request at a time, or ask the owner to set the batch size.',
  },
  'support.bulk_too_large': {
    title: 'That is more requests than the desk allows at once',
    body: 'svc-support caps how many requests one bulk change may touch, and this batch is over it.',
    next: 'Nothing was changed. Tick fewer requests and send again.',
  },
  'support.merge_not_allowed': {
    title: 'Those requests cannot be merged',
    body: 'Both requests must be open, pending or on hold and belong to the same customer account. One of them is not, or the duplicate was already merged into another request.',
    next: 'Nothing was changed. Check both ticket ids, then try again.',
  },
  'support.merge_same_ticket': {
    title: 'A request cannot be merged into itself',
    body: 'The request that stays must be a different request from the duplicate.',
    next: 'Nothing was changed. Paste the id of the other request.',
  },
  'support.not_lead': {
    title: 'Only a lead can do that',
    body: 'Setting another person’s availability, and making or changing desk groups, need the lead role. Anyone on the staff list can set their own availability.',
    next: 'Nothing was changed.',
  },
  'support.group_unknown': {
    title: 'No such group',
    body: 'svc-support does not have that group. It may have been removed.',
    next: 'Refresh the groups and try again. Nothing was changed.',
  },
  'support.group_name_taken': {
    title: 'A group with that name exists',
    body: 'Group names are unique.',
    next: 'Pick a different name. Nothing was changed.',
  },
  'support.group_member_duplicate': {
    title: 'Already in that group',
    body: 'That person is already a member.',
    next: 'Nothing was changed.',
  },
  'support.availability_invalid': {
    title: 'svc-support did not accept that availability',
    body: 'Availability is online, busy or offline.',
    next: 'Pick one of the three. Nothing was changed.',
  },
  'support.property_invalid': {
    title: 'svc-support did not accept that priority or type',
    body: 'Priority is one of low, normal, high or urgent. Type is one of question, problem or incident.',
    next: 'Pick one of the listed values. Nothing was changed.',
  },
  'support.label_invalid': {
    title: 'svc-support did not accept a label',
    body: 'A label may hold letters, digits, hyphen and underscore only. A space is not allowed.',
    next: 'Fix the label and try again. Nothing was changed.',
  },
  'support.ticket_closed': {
    title: 'This ticket is closed',
    body: 'svc-support does not change the properties of a closed ticket.',
    next: 'Nothing was changed.',
  },
  'support.kb.revision_stale': {
    title: 'Someone changed this article first',
    body: 'The revision you used is no longer the latest, so svc-support refused to overwrite.',
    next: 'Reload the articles and try again from the new revision. Nothing was changed.',
  },
  'support.kb.not_published': {
    title: 'That article is not published',
    body: 'It is already hidden from customers.',
    next: 'Nothing was changed.',
  },
  'support.kb_invalid': {
    title: 'svc-support did not accept that article',
    body: 'The id or the text keys are not valid for the help library.',
    next: 'Check the id and both keys against the translation catalogue. Nothing was changed.',
  },
  'support.kb_audience_invalid': {
    title: 'svc-support did not accept that audience',
    body: 'The audience must be everyone, signed-in customers only, or staff only.',
    next: 'Pick one of the three and try again. Nothing was changed.',
  },
  'support.kb_vendor_name': {
    title: 'Article keys may not name another company’s product',
    body: 'The help library refuses keys that carry a third-party product name.',
    next: 'Use a general key. Nothing was changed.',
  },
};
const SUPPORT_CODE = /\bsupport(?:\.[a-z0-9_]+)+/;

export function supportCodeOf(message: string, code: string | null): string | null {
  return SUPPORT_CODE.exec(message)?.[0] ?? (code && SUPPORT_CODE.test(code) ? code : null);
}

/** Every non-ok answer to a support write or read, as a view the page and the BFF share. Never a success, never a raw code. */
export function explainSupportFailure(result: FounderCallFailure<unknown>): RefusalView {
  switch (result.kind) {
    case 'forbidden': {
      const staffCode = supportCodeOf(result.refusal.message, result.refusal.code);
      if (staffCode === 'support.not_staff' || staffCode === 'support.not_lead')
        return { ...BY_SUPPORT_CODE[staffCode]!, code: staffCode, changed: 'no' };
      if (result.refusal.status === 401) return explainRefusal('admin.session_required', 401, false);
      return {
        title: SUPPORT_OPS_FORBIDDEN,
        body: SUPPORT_OPS_FORBIDDEN_BODY,
        next: 'Nothing was changed. This control works once the permission is granted.',
        code: result.refusal.code ?? 'scope.denied',
        changed: 'no',
      };
    }
    case 'refused': {
      const named = supportCodeOf(result.refusal.message, result.refusal.code);
      const known = named ? BY_SUPPORT_CODE[named] : undefined;
      if (known) return { ...known, code: named, changed: 'no' };
      if (result.refusal.status === 404) return { ...BY_SUPPORT_CODE['support.not_found']!, code: named, changed: 'no' };
      return explainRefusal(named ?? result.refusal.code, result.refusal.status, false);
    }
    case 'not_built':
      return {
        title: 'svc-support has not switched this on',
        body: 'The service answered that it has no such operation on this deployment.',
        next: 'Nothing was changed. Ask engineering.',
        code: 'not_built',
        changed: 'no',
      };
    case 'unavailable':
      return explainRefusal(null, 503, result.uncertain);
    case 'invalid':
      return {
        title: 'The outcome is not known',
        body: 'svc-support answered in a shape this console does not understand, so it cannot say whether this went through.',
        next: 'Read the ticket or the articles again before doing anything twice.',
        code: null,
        changed: 'unknown',
      };
  }
}
