/**
 * Plain-English answers for the typed refusals the desks can receive. A founder at 3am should read what happened
 * and what to do next, never a status number or a raw service sentence.
 *
 * `changed` says whether anything may have changed: 'no' for a definite refusal before any effect, 'unknown' when
 * the outcome could not be established. A desk must never call an 'unknown' a failure or a success.
 */

export interface RefusalView {
  readonly title: string;
  readonly body: string;
  readonly next: string;
  readonly code: string | null;
  readonly changed: 'no' | 'unknown';
}

interface Entry {
  readonly title: string;
  readonly body: string;
  readonly next: string;
  readonly changed?: 'no' | 'unknown';
}

const BY_CODE: Readonly<Record<string, Entry>> = {
  'custody_approval.initiator_cannot_decide': {
    title: 'A different approver has to decide this',
    body: 'The person who started a task cannot approve or reject it. Nothing was recorded.',
    next: 'Ask another registered approver to decide it from their own console or phone.',
  },
  'custody_approval.approver_not_registered': {
    title: 'You are not a registered approver',
    body: 'Only an active registered approver can approve or reject a custody task. Nothing was recorded.',
    next: 'Ask a founder to register you as an approver, then try again.',
  },
  'custody_approval.hash_mismatch': {
    title: 'That is not the request you read',
    body: 'The task on file is not the one that matched the fingerprint you were shown, so nothing was approved or rejected.',
    next: 'Reload the task, read it again and decide on what it says now.',
  },
  'custody_approval.not_pending': {
    title: 'This task is no longer waiting for a decision',
    body: 'It was already approved, rejected, cancelled, run or has expired.',
    next: 'Read its timeline. If it still needs doing, ask for a new task.',
  },
  'custody_approval.expired': {
    title: 'This task passed its deadline',
    body: 'An expired task never runs. Nothing was approved.',
    next: 'Ask for a new task if the work is still needed.',
  },
  'custody_approval.not_found': {
    title: 'That task was not found',
    body: 'There is no task with that id for your session.',
    next: 'Reload the list.',
  },
  'custody_approval.quorum_unset': {
    title: 'The number of approvers is not set',
    body: 'The owner has not set how many approvers a task needs, so no task can start or be decided.',
    next: 'Ask the owner to set it. Nothing was changed.',
  },
  restriction_no_four_eyes: {
    title: 'Lifting this freeze needs a second person',
    body: 'Identity restores a frozen account only with an approval a different person signed. Nothing was changed.',
    next: 'Make the request, send the packet to the other founder, and run it once they approve.',
  },
  restriction_approval_mismatch: {
    title: 'That approval is not for this change',
    body: 'Identity checked the approval against this account, its current version and the reason, and they differ, or the approval was made or signed by someone it does not accept for this account. Nothing was changed and the approval was not used.',
    next: 'Read the account again and make a new request.',
  },
  restriction_approval_consumed: {
    title: 'That approval was already used',
    body: 'An approval runs once. Nothing was changed by this attempt.',
    next: 'Read the account again: if an earlier run went through and its answer was lost, the change is already there. If it still needs doing, make a new request.',
  },
  'restriction.version_conflict': {
    title: 'The account changed since you read it',
    body: 'Identity applies the change only to the version that was approved. Nothing was changed.',
    next: 'Read the account again and make a new request if it is still needed.',
  },
  'target.not_found': {
    title: 'Identity has no such account',
    body: 'Nothing was changed.',
    next: 'Check the platform user ID and inspect the account again.',
  },
  'request.conflict': {
    title: 'That request id was already used for a different change',
    body: 'Identity keeps one answer per request id, and this one belongs to another change. Nothing was changed.',
    next: 'Run it again from the desk: each run takes a new request id.',
  },
  'identity.close_requires_approver': {
    title: 'Closing or reopening needs a second person',
    body: 'Identity closes or reopens an account only with an approval a different person signed. Nothing was changed.',
    next: 'Make the request, send the packet to the other founder, and run it once they approve.',
  },
  'identity.close_approval_mismatch': {
    title: 'That approval is not for this change',
    body: 'Identity checked the approval against this account, its current version, the reason code and the reason, and they differ, or the approval was made or signed by someone it does not accept for this account. Nothing was changed and the approval was not used.',
    next: 'Read the account again and make a new request.',
  },
  'identity.close_approval_consumed': {
    title: 'That approval was already used',
    body: 'An approval runs once. Nothing was changed by this attempt.',
    next: 'Read the account again: if an earlier run went through and its answer was lost, the change is already there. If it still needs doing, make a new request.',
  },
  'identity.close_blocked': {
    title: 'The account still has open products or balances',
    body: 'Identity asked the bank, trading and P2P services before closing, and at least one still holds something for this account. Nothing was changed and the approval was not used.',
    next: 'Settle or move what is open, then run the same approval again.',
  },
  'identity.close_check_unavailable': {
    title: 'Identity could not check the account before closing',
    body: 'One of the services identity asks before a close did not answer. Nothing was changed and the approval was not used.',
    next: 'Try again later with the same approval.',
  },
  'identity.close_founder_forbidden': {
    title: 'A founder account cannot be closed here',
    body: 'Identity refuses to close either founder account from the console. Nothing was changed.',
    next: 'Nothing to do here.',
  },
  'identity.close_self_forbidden': {
    title: 'You cannot close your own account',
    body: 'Identity refuses a close of the account making the request. Nothing was changed.',
    next: 'Nothing to do here.',
  },
  'identity.close_already_closed': {
    title: 'The account is already closed',
    body: 'Nothing was changed.',
    next: 'Read the account again.',
  },
  'identity.reopen_not_closed': {
    title: 'The account is not closed',
    body: 'Only a closed account can be reopened. Nothing was changed.',
    next: 'Read the account again.',
  },
  'identity.reopen_not_allowed': {
    title: 'This account cannot be reopened',
    body: 'Identity reopens only an account the customer closed. This one was closed by staff for another reason, so it stays closed. Nothing was changed.',
    next: 'The customer would need a new application.',
  },
  'identity.account_tiers_unset': {
    title: 'No account tiers are set',
    body: 'The owner has not published the account tiers (IDENTITY_ACCOUNT_TIERS), so identity moves no account onto any tier. Nothing was changed.',
    next: 'The owner sets the tiers and their terms; nothing here fills them in.',
  },
  'identity.tier_unknown': {
    title: 'That tier is not on offer',
    body: 'Identity does not list a tier with that id. Nothing was changed.',
    next: 'Read the account again and choose one of the tiers listed.',
  },
  'identity.tier_terms_unset': {
    title: 'That tier has blank terms',
    body: 'A tier with any blank rate, fee, limit or clearing period cannot be assigned, and identity does not fill one in. Nothing was changed and the approval was not used.',
    next: 'The owner completes the tier’s terms, or choose a tier whose terms are all set.',
  },
  'identity.tier_unchanged': {
    title: 'The account is already on that tier',
    body: 'Nothing was changed.',
    next: 'Read the account again.',
  },
  'identity.tier_self_forbidden': {
    title: 'You cannot move your own account',
    body: 'A founder does not change the tier of their own account. Nothing was changed.',
    next: 'The other founder can make the request.',
  },
  'identity.tier_account_closed': {
    title: 'The account is closed',
    body: 'Identity does not move a closed account onto a tier. Nothing was changed.',
    next: 'Reopen the account first if that is allowed.',
  },
  'identity.tier_requires_approver': {
    title: 'A second founder must approve this first',
    body: 'Identity moves an account onto a tier only with a second founder’s approval. Nothing was changed.',
    next: 'Ask the other founder to approve the request, then run it.',
  },
  'identity.tier_approval_mismatch': {
    title: 'That approval is not for this change',
    body: 'The approval does not match this account, tier, reason or tier version, was not approved by a different founder who is still a founder, or has expired. Nothing was changed.',
    next: 'Read the account again and make a new request if it still needs doing.',
  },
  'identity.tier_approval_consumed': {
    title: 'That approval was already used',
    body: 'An approval runs once. Nothing was changed by this attempt.',
    next: 'Read the account again: if an earlier run went through and its answer was lost, the move is already there. If it still needs doing, make a new request.',
  },
  'action_approval.same_person': {
    title: 'A different founder has to do this',
    body: 'The person who made the request cannot approve it or reject it. Identity enforces this.',
    next: 'Send the request packet to the other founder. They approve it from their own console.',
  },
  'action_approval.payload_mismatch': {
    title: 'That approval is for a different request',
    body: 'The request you reviewed is not the one the approval was created for. Nothing was approved or used.',
    next: 'Ask the first founder to send a fresh request packet and review it again.',
  },
  'action_approval.not_pending': {
    title: 'This request is no longer waiting for a decision',
    body: 'It was already approved, rejected, withdrawn, used or has expired.',
    next: 'If it was approved, run it. Otherwise start a new request.',
  },
  'action_approval.not_approved': {
    title: 'The second approver has not approved this yet',
    body: 'Identity will not let this run until a different approver has approved exactly this request: another operator for a module kill or re-enable, another founder for a ledger unfreeze. Nothing was changed.',
    next: 'Ask the second approver to approve the request packet, then run it.',
  },
  'auth_key.approval_required': {
    title: 'The approval did not cover this key change',
    body: 'Identity checked the approval against the exact key change and refused it: it is missing, not approved, already used, expired, or for a different change. Nothing was changed.',
    next: 'Read the key state below. If the ids still make sense, start a new request.',
  },
  'auth_key.material_missing': {
    title: 'That key has no secret on the identity host',
    body: 'A key id can only be rotated to once its secret is in the identity service settings. Secrets are never entered in this console.',
    next: 'Ask whoever runs the host to add the key to the identity key list, then start a new request.',
  },
  'auth_key.already_known': {
    title: 'That key id was used before',
    body: 'An id is never reused, even after its key was removed. Nothing was changed.',
    next: 'Pick a new key id that the identity host has a secret for.',
  },
  'auth_key.nothing_to_remove': {
    title: 'There is no previous key to remove',
    body: 'Only the signing key is in use, so there is nothing to retire. Nothing was changed.',
    next: 'Read the key state below.',
  },
  'auth_key.invalid_id': {
    title: 'That key id is not allowed',
    body: 'A key id is lowercase letters, digits, dots, dashes or underscores, up to 32 characters, and is never the word legacy.',
    next: 'Nothing was changed. Pick another id.',
  },
  'action_approval.expired': {
    title: 'This approval expired',
    body: 'Approvals only last a short time. Nothing was changed.',
    next: 'Start a new request.',
  },
  'action_approval.consumed': {
    title: 'This approval was already used',
    body: 'An approval can run once. If the first run went through, the current state below shows it.',
    next: 'Read the current state. If it is not what you intended, start a new request.',
    changed: 'unknown',
  },
  'action_approval.not_found': {
    title: 'No such approval',
    body: 'Identity does not know this approval id. Nothing was changed.',
    next: 'Check the request packet was copied whole, or start a new request.',
  },
  'action_approval.already_terminal': {
    title: 'This request is already finished',
    body: 'It was rejected, withdrawn or used, so it cannot change again.',
    next: 'Start a new request if you still need it.',
  },
  'action_approval.not_requester': {
    title: 'Only the founder who made the request can withdraw it',
    body: 'Withdrawing is the requester’s undo. The other founder can reject it instead.',
    next: 'Use Reject if you are the second founder.',
  },
  'action_approval.founder_only': {
    title: 'This needs two current founders',
    body: 'Identity checked the founder list right now and one of the two people is not a current founder.',
    next: 'Nothing was changed. Check founder access with engineering.',
  },
  'action_approval.operator_only': {
    title: 'Your account is not an operator for this',
    body: 'Identity only lets operators and founders act on this kind of request.',
    next: 'Sign in as a founder.',
  },
  'action_approval.founders_unavailable': {
    title: 'Identity could not read the founder list',
    body: 'It refuses closed when it cannot check. Nothing was changed.',
    next: 'Try again in a minute. If it keeps failing, tell engineering.',
  },
  'action_approval.target_mismatch': {
    title: 'The thing changed since this was requested',
    body: 'The approval was made for an earlier state or a different operation, so it cannot be used. Nothing was changed.',
    next: 'Read the current state and start a new request.',
  },
  'action_approval.ttl_unset': {
    title: 'Approvals are not switched on in this deployment',
    body: 'Identity has no approval lifetime configured, so it cannot create approvals. Nothing was changed.',
    next: 'Ask engineering to set the approval lifetime.',
  },
  'action_approval.type_not_four_eyes': {
    title: 'This kind of request cannot be approved here',
    body: 'Identity does not accept it as a two-founder approval.',
    next: 'Nothing was changed.',
  },
  'action_approval.identity_unwired': {
    title: 'The edge is not connected to identity approvals',
    body: 'svc-edge could not check approvals, so it refused the command. Nothing was changed.',
    next: 'Ask engineering to connect svc-edge to identity.',
  },
  'action_approval.missing': {
    title: 'The command did not include its approval',
    body: 'svc-edge refused it before doing anything.',
    next: 'Start from the request step.',
  },
  'action_approval.consume_failed': {
    title: 'Identity refused to release the approval',
    body: 'Most often the second founder has not approved yet, or the approval expired. The command was not run.',
    next: 'Check with the other founder, then try again, or start a new request.',
  },
  'pay.halt_target_not_found': {
    title: 'No such merchant',
    body: 'svc-pay does not know that merchant id. Nothing was changed.',
    next: 'Check the id and try again.',
  },
  'pay.halt_target_unsupported': {
    title: 'That target does not work with that operation',
    body: 'A user or rail halt only works on payouts, and a user id must be a UUID. Nothing was changed.',
    next: 'Pick the payout operation, or a global or merchant target.',
  },
  'pay.halt_target_unknown_rail': {
    title: 'svc-pay does not know that rail',
    body: 'Only rails registered on this deployment can be halted. Nothing was changed.',
    next: 'Check the rail id.',
  },
  'pay.halt_store_unavailable': {
    title: 'The halt store is unavailable',
    body: 'svc-pay cannot read or write halts right now. While it cannot read them, every operation counts as halted.',
    next: 'Nothing was changed. Try again, and tell engineering if it persists.',
  },
  'admin.kill_self_lockout': {
    title: 'This console will not kill identity',
    body: 'Identity carries founder sign-in and the approvals this console needs, so killing it would stop you from re-enabling it.',
    next: 'Use Account controls to freeze accounts. If the edge is stuck, have engineering fix the kill-state file: an unreadable kill-state halts every module on boot. Nothing was changed.',
  },
  'admin.kill_not_enforceable': {
    title: 'The edge cannot halt this module',
    body: 'No route on this edge forwards to it, so a kill would be recorded but refuse nothing.',
    next: 'Nothing was changed.',
  },
  'admin.kill_unconfigured': {
    title: 'The console is not set up to reach the edge',
    body: 'The edge address or the module operator credential is missing on this deployment, so nothing was sent.',
    next: 'Ask engineering to configure the console. Nothing was changed.',
  },
  'admin.ledger_unconfigured': {
    title: 'The console is not set up to reach the ledger',
    body: 'The edge address or the treasury credential is missing on this deployment, so nothing was sent.',
    next: 'Ask engineering to configure the console. Nothing was changed.',
  },
  'edge.ledger_unreachable': {
    title: 'The edge cannot reach the ledger',
    body: 'svc-edge has no route to svc-ledger on this deployment, so nothing was sent to it.',
    next: 'Ask engineering. Nothing was changed.',
  },
  'notify.notice_publish_same_operator': {
    title: 'The approver cannot also publish',
    body: 'svc-notify publishes only for a founder other than the one who approved, so this approval was used up and nothing was published.',
    next: 'Ask for approval again; the founder who did not approve publishes.',
  },
  'notify.notice_approval_spent': {
    title: 'That approval is already used',
    body: 'svc-notify spends each approval once. Nothing more was published.',
    next: 'Read the incident again. If the entry is still a draft, ask for a new approval.',
  },
  'notify.notice_incident_resolved': {
    title: 'This incident is resolved',
    body: 'A resolved incident is final, so svc-notify takes no further update on it. Nothing was saved.',
    next: 'If the problem is back, declare a new incident.',
  },
  'notify.notice_published_immutable': {
    title: 'Already published',
    body: 'A published entry is never edited. Nothing was changed.',
    next: 'Post an update with the correction instead.',
  },
  'notify.notice_impact_unset': {
    title: 'Name the impact',
    body: 'An incident that names components has to say how bad it is. Nothing was saved.',
    next: 'Pick an impact and save again.',
  },
  'notify.notice_component_unknown': {
    title: 'That component is not on the status page',
    body: 'svc-notify does not know one of the components named. Nothing was saved.',
    next: 'Read the desk again and pick from the components it lists.',
  },
  'notify.notice_copy_unset': {
    title: 'Write a title and a message',
    body: 'Both are needed. Nothing was saved.',
    next: 'Fill them in and save again.',
  },
  'notify.notice_parent_invalid': {
    title: 'That incident cannot take an update',
    body: 'Updates go on a published incident, never on a draft or on another update. Nothing was saved.',
    next: 'Publish the incident first, then post the update.',
  },
  'status.template_invalid': {
    title: 'That template is not complete',
    body: 'A template needs an id (lowercase letters, digits and dashes), a name, a title and a message. Nothing was saved.',
    next: 'Correct it and save again.',
  },
  'status.template_component_unknown': {
    title: 'That component is not on the status page',
    body: 'A template may only name components the page defines. Nothing was saved.',
    next: 'Pick from the components the desk lists.',
  },
  'status.template_impact_unset': {
    title: 'Name the impact',
    body: 'A template that names components has to say how bad the incident is. Nothing was saved.',
    next: 'Pick an impact and save again.',
  },
  'status.template_cap_reached': {
    title: 'Too many templates',
    body: 'svc-notify keeps at most 100 active templates. Nothing was saved.',
    next: 'Retire one you no longer use, then save again.',
  },
  'status.template_not_found': {
    title: 'No such template',
    body: 'That template is not active. Nothing was changed.',
    next: 'Read the desk again.',
  },
  'status.component_cap_unset': {
    title: 'The component cap is blank',
    body: 'svc-notify refuses any list of components until a founder sets how many the page may hold. Nothing was changed.',
    next: 'Fill in the component cap in the same change, then save again.',
  },
  'status.component_cap_reached': {
    title: 'More components than the cap allows',
    body: 'The list is longer than the component cap, so svc-notify kept the page as it was.',
    next: 'Remove components or raise the cap, then save again.',
  },
  'status.component_unknown': {
    title: 'That component is not on the page',
    body: 'svc-notify has no component with that id, so no reading was stored.',
    next: 'Read the page again and pick a component it lists.',
  },
  'status.reading_in_future': {
    title: 'That reading is in the future',
    body: 'A reading cannot be later than the service clock, so nothing was stored.',
    next: 'Check the time and enter the reading again.',
  },
  'status.reading_conflict': {
    title: 'A different reading exists for that moment',
    body: 'svc-notify already holds another state for this component at that exact time. Nothing was stored.',
    next: 'Read the page again; enter a new reading for the time it is now.',
  },
  'status.page_revision_stale': {
    title: 'Someone changed the page first',
    body: 'The definition moved on since you read it, so your change was not applied.',
    next: 'Read the page again and make your change on what it says now.',
  },
  'operator.denied': {
    title: 'Not allowed',
    body: 'The service did not accept your founder session for this action.',
    next: 'Sign out and in again. Nothing was changed.',
  },
  'mfa.required': {
    title: 'A second factor is needed',
    body: 'Your session does not carry a verified second factor.',
    next: 'Sign out and sign in with your authenticator, then repeat this step.',
  },
  'scope.denied': {
    title: 'Your session does not hold the permission this needs',
    body: 'The service checks permissions itself and refused. Founder sign-in does not carry staff permissions by default.',
    next: 'Nothing was changed. See the back-end needs note for the permission to grant.',
  },
  'scope.insufficient': {
    title: 'Your session does not hold the permission this needs',
    body: 'The service checks permissions itself and refused.',
    next: 'Nothing was changed.',
  },
  'p2p.dispute_already_resolved': {
    title: 'This dispute is already resolved',
    body: 'A moderator ruled on it, or the trade is no longer in dispute, so there is nothing to escalate.',
    next: 'Read the dispute list again. Nothing was changed.',
  },
  'p2p.dispute_not_found': {
    title: 'No such dispute',
    body: 'svc-p2p does not know that dispute id.',
    next: 'Read the dispute list again. Nothing was changed.',
  },
  'p2p.not_a_moderator': {
    title: 'You are not a P2P moderator',
    body: 'svc-p2p only lets moderators act on disputes: the moderator list, or the compliance permission.',
    next: 'Nothing was changed. Ask who grants moderator access.',
  },
  'p2p.moderation_unreachable': {
    title: 'No P2P moderators are set up',
    body: 'svc-p2p has an empty moderator list, so it refuses every dispute action rather than guess who may act.',
    next: 'Nothing was changed. Tell engineering.',
  },
  'p2p.ruling_not_attributed': {
    title: 'This action must be tied to a person',
    body: 'svc-p2p only records a dispute action against a named person account, not a service or a key.',
    next: 'Sign in as yourself. Nothing was changed.',
  },
  'bank.card_command_conflict': {
    title: 'That request key was used for something else',
    body: 'svc-bank has already seen this request key for a different card or status.',
    next: 'Start a new request. Nothing was changed.',
  },
  'bank.ops_reason_too_short': {
    title: 'The reason is too short',
    body: 'svc-bank wants at least 10 characters of reason for an operator card freeze.',
    next: 'Nothing was changed. Start a new request with a fuller reason.',
  },
  'market.listing_taken_down': {
    title: 'This listing is already taken down',
    body: 'A taken-down listing stays down for good, so there is nothing more to do.',
    next: 'Read the listings again. Nothing was changed.',
  },
  'market.takedown_approval_mismatch': {
    title: 'That approval is for a different takedown',
    body: 'The approval svc-market found is not for this listing and this reason, so the listing was left as it was.',
    next: 'Start a new request.',
  },
  'market.idempotency_conflict': {
    title: 'That request key was used for something else',
    body: 'svc-market has already seen this request key for a different listing.',
    next: 'Start a new request. Nothing was changed.',
  },
  'notify.release_reason_required': {
    title: 'A reason is needed to release this address',
    body: 'svc-notify records why an address was released and refuses a blank or too short reason.',
    next: 'Nothing was changed. Write why this address is safe to send to again.',
  },
  'notify.recipient_unknown': {
    title: 'No such address',
    body: 'svc-notify has no record of that person on that channel.',
    next: 'Read the list again. Nothing was changed.',
  },
  'notify.recipient_not_quarantined': {
    title: 'This address is not quarantined',
    body: 'Someone released it first, or it never was quarantined, so there is nothing to lift.',
    next: 'Read the list again. Nothing was changed.',
  },
  'admin.session_required': {
    title: 'You are signed out',
    body: 'Your founder session ended.',
    next: 'Sign in again, then repeat this step. Nothing was changed.',
  },
  'admin.session_csrf': {
    title: 'The page and your session are out of step',
    body: 'The request carried an old session marker, so it was refused.',
    next: 'Reload the page and try again. Nothing was changed.',
  },
};

const UNKNOWN_UNCERTAIN: Entry = {
  title: 'The outcome is not known',
  body: 'The connection ended or the service did not answer in time, so it is not known whether this went through.',
  next: 'Read the current state below before doing anything again.',
  changed: 'unknown',
};

export function isKnownCode(code: string | null | undefined): code is string {
  return typeof code === 'string' && Object.hasOwn(BY_CODE, code);
}

/**
 * `uncertain` defaults to "the service failed (5xx)". A known code is always a definite answer, whatever the status.
 * Pass `true` for a timeout or a dropped connection on a write.
 */
export function explainRefusal(code: string | null, status: number, uncertain = status >= 500): RefusalView {
  const entry = isKnownCode(code) ? BY_CODE[code] : undefined;
  if (entry) return { title: entry.title, body: entry.body, next: entry.next, code, changed: entry.changed ?? 'no' };
  if (uncertain) return { ...UNKNOWN_UNCERTAIN, code, changed: 'unknown' };
  if (status === 401 || status === 403) {
    return {
      title: 'Not allowed',
      body: 'The service did not accept this action for your session.',
      next: 'Nothing was changed. Sign out and in again if this is unexpected.',
      code,
      changed: 'no',
    };
  }
  if (status === 404) {
    return {
      title: 'Not found',
      body: 'The service did not recognise what was asked for.',
      next: 'Nothing was changed.',
      code,
      changed: 'no',
    };
  }
  if (status === 409 || status === 412) {
    return {
      title: 'The state moved on',
      body: 'Someone else changed this first, so the request no longer applies.',
      next: 'Read the current state and decide again. Nothing was changed.',
      code,
      changed: 'no',
    };
  }
  return {
    title: 'The service refused this',
    body: 'It gave no reason this console recognises.',
    next: 'Nothing was changed. Read the current state and try again if it still makes sense.',
    code,
    changed: 'no',
  };
}

/**
 * Edge and ledger wrap identity's failure into a sentence that carries the typed code in square brackets
 * (`identity refused consumeForEdge (412) ... [action_approval.not_approved]`). Pull it out so the desk can
 * explain it. Returns the first known `action_approval.*` code in the text, or null.
 */
export function codeInText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const match of text.matchAll(/\b(action_approval\.[a-z_]+)\b/g)) if (isKnownCode(match[1])) return match[1];
  return null;
}
