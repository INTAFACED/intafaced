import type { PlainRefusal } from './registry-model';

/**
 * Plain-English refusals for the merchant control room (W1: changes, approvals) and for halts (W5).
 * Keys are the typed codes svc-pay puts in `error.data.cause.code`. The wording says what was refused,
 * why, and what to do next; it never shows a code or a stack.
 */
export const CONTROL_COPY: Record<string, PlainRefusal> = {
  'pay.merchant_not_found': {
    title: 'That merchant does not exist',
    body: 'The service has no merchant with that id.',
    next: 'Go back to All merchants and open it from there.',
  },
  'pay.tier_not_found': {
    title: 'That tier does not exist',
    body: 'A merchant can only be put on a tier that an owner has already defined.',
    next: 'Pick one of the listed tiers. Tier definitions are set up separately and are not changed from this page.',
  },
  'pay.change_not_found': {
    title: 'No pending change with that reference',
    body: 'The request reference was not found, or it belongs to a kind of change this page does not confirm.',
    next: 'Check you copied the whole reference from the other founder, or ask them to submit the change again.',
  },
  'pay.change_not_pending': {
    title: 'That change has already been decided',
    body: 'It was confirmed, declined or found out of date before.',
    next: 'Reload the merchant to see what is in force now. Submit a new change if it is still needed.',
  },
  'pay.request_id_reused': {
    title: 'That request reference was already used for a different change',
    body: 'Each change needs its own reference.',
    next: 'Go back, review the change again and submit it as a new request.',
  },
  'pay.change_hash_mismatch': {
    title: 'That is not the change on file',
    body: 'The request on file for that reference is a different change from the one you were shown (another merchant, another kind of change or other values). Nothing was applied or declined.',
    next: 'Do not confirm it. Ask the other founder to send the request again, and read it carefully. If it keeps happening, tell engineering.',
  },
  'pay.dual_control_required': {
    title: 'A different founder has to do this step',
    body: 'The same founder cannot both submit and confirm a change. Dual control needs two different people, each signed in themselves.',
    next: 'Ask the other founder to open this page in their own sign-in.',
  },
  'pay.control_invalid': {
    title: 'The service did not accept these values',
    body: 'One of the values failed the service’s own check.',
    next: 'Review the form and try again. Nothing was changed.',
  },
  'pay.reserve_ledger_unwired': {
    title: 'Reserves cannot be changed yet',
    body: 'The ledger side of a rolling reserve is not connected on this deployment, so a reserve cannot be set or changed.',
    next: 'Nothing was changed. Ask engineering when the reserve ledger is switched on.',
  },
  'pay.approval_not_found': {
    title: 'That approval does not exist',
    body: 'It may have been withdrawn, or the reference is wrong.',
    next: 'Reload the approvals queue.',
  },
  'pay.approval_self_approval': {
    title: 'You cannot decide an approval you took part in',
    body: 'The founder step must be done by founders who were not the requester or the merchant-side approver.',
    next: 'Ask a different founder to open the approvals queue.',
  },
  'pay.approval_not_pending': {
    title: 'That approval is no longer waiting for a founder',
    body: 'It was already decided, or it is not at the founder step.',
    next: 'Reload the approvals queue to see what is still waiting.',
  },
  'pay.approval_expired': {
    title: 'That approval has run out of time',
    body: 'Approvals only stay valid for a limited time.',
    next: 'The merchant has to request the payout again.',
  },
  'pay.approval_payload_mismatch': {
    title: 'The payout changed after you opened it',
    body: 'Your decision is bound to the exact payout you reviewed, and it is not the same any more.',
    next: 'Reload the queue and review the payout again. Nothing was approved.',
  },
  'pay.approval_forbidden': {
    title: 'You cannot decide this approval',
    body: 'The service refused the decision for this sign-in.',
    next: 'Check your founder access with the other founder.',
  },
  'pay.approval_mfa_required': {
    title: 'Your sign-in is missing the second factor',
    body: 'Approving a payout needs a session that completed multi-factor sign-in.',
    next: 'Sign out and in again with your authenticator or passkey.',
  },
  'pay.approval_state_invalid': {
    title: 'This approval is in a state that cannot be decided',
    body: 'Its current state does not allow the decision you made.',
    next: 'Reload the approvals queue.',
  },
  'pay.tier_unassigned': {
    title: 'This merchant has no tier yet',
    body: 'Caps sit on top of a tier’s caps, so they cannot be set first, and until a merchant has a tier its payments refuse.',
    next: 'Assign a tier first (the Tier change), then set caps.',
  },
  'pay.pricing_unconfigured': {
    title: 'No pricing is configured, so payments refuse',
    body: 'Nobody has set a fee for this merchant, its tier or globally.',
    next: 'Set pricing from the Controls tab.',
  },
  'pay.halt_store_unavailable': {
    title: 'The halt store could not be read',
    body: 'An unreadable store counts as halted, so treat every operation as paused.',
    next: 'Wait a moment and reload. If it keeps failing, tell engineering.',
  },
  'pay.halt_target_not_found': {
    title: 'That merchant does not exist',
    body: 'A halt can only target a merchant that exists.',
    next: 'Go back to All merchants.',
  },
  'pay.halt_target_unsupported': {
    title: 'A user or rail halt only pauses payouts',
    body: 'Intake, settlement and conversion can be halted for everyone or for one merchant. A user halt pauses that person’s payouts, and it needs a user id.',
    next: 'Choose Paying out, or halt everyone or one merchant.',
  },
  'pay.halt_target_unknown_rail': {
    title: 'That rail is not registered',
    body: 'A payout halt can only name a rail this deployment sends on.',
    next: 'Pick a registered rail.',
  },
  // ── business verification documents (J-merchant-02 step 3) ──
  'pay.kyb_document_already_reviewed': {
    title: 'This document already has a verdict',
    body: 'A verdict is final for that file. While the application is under review, the merchant answers Invalid by sending a new file for that document.',
    next: 'Reload the Verification tab to see the verdict in force.',
  },
  'pay.kyb_document_not_current': {
    title: 'A newer file replaced this one',
    body: 'The merchant sent another file for this document, or started the application again, so this file no longer counts.',
    next: 'Reload the Verification tab and review the file shown there.',
  },
  'pay.kyb_document_not_found': {
    title: 'That document is not on this application',
    body: 'The service has no such upload for the merchant’s current application.',
    next: 'Reload the Verification tab.',
  },
  'pay.kyb_review_reason_required': {
    title: 'A rejection needs a reason',
    body: 'The merchant reads the reason next to the document, so it has to say what to fix.',
    next: 'Write the reason and reject again.',
  },
  'pay.kyb_doc_key_unset': {
    title: 'Documents cannot be opened here',
    body: 'The key that encrypts business documents is not set for this deployment, so no file can be read.',
    next: 'Nothing was opened. The key is an owner setting.',
  },
  'pay.kyb_document_unreadable': {
    title: 'This file does not open',
    body: 'It does not open with the current document key, or it does not match the digest recorded when it was sent.',
    next: 'Mark it Invalid with that reason so the merchant sends the file again, and tell engineering.',
  },
  'pay.kyb_application_not_found': {
    title: 'That application does not exist',
    body: 'The service has no business application with that id.',
    next: 'Reload the Verification tab.',
  },
  'pay.kyb_request_key_conflict': {
    title: 'That request was already sent with other words',
    body: 'A request with the same key exists for this merchant with different words or a different due date.',
    next: 'Reload the Verification tab and check the requests listed there.',
  },
  'pay.kyb_request_due_past': {
    title: 'The due date has passed',
    body: 'A request needs a due date in the future, so the merchant has time to answer.',
    next: 'Pick a later due date and send it again. Nothing was sent.',
  },
  'pay.kyb_request_asked_before': {
    title: 'This exact request was already sent',
    body: 'A request with the same words and due date was sent to this merchant and is already answered or closed, so nothing new went out.',
    next: 'To ask again, change the words or the due date.',
  },
  'pay.kyb_request_closed': {
    title: 'This request is already closed',
    body: 'It was closed with another note. A closed request stays as it is.',
    next: 'Reload the Verification tab to see who closed it.',
  },
  'pay.kyb_request_not_found': {
    title: 'That request does not exist',
    body: 'The service has no information request with that id.',
    next: 'Reload the Verification tab.',
  },
  'pay.kyb_request_file_not_found': {
    title: 'This answer has no file',
    body: 'The merchant answered with a note only.',
    next: 'Read the note on the request.',
  },
  'pay.kyb_application_decided': {
    title: 'This application is already decided',
    body: 'INTAFACED approved or turned down this application, so its documents take no more verdicts.',
    next: 'Reload the Verification tab. A turned-down merchant starts a new application.',
  },
};
