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
  // svc-token governance founder doors (J-more-catalogue-10). Each is checked before the approval is spent, except a
  // founder approving a role for their own account, which only the approval names.
  'token.settings_invalid': {
    title: 'Those settings are outside what governance stores',
    body: 'The voting delay is 0 to one year and the voting period more than 0 and at most one year. Nothing was changed.',
    next: 'Pick figures in range and ask again.',
  },
  'token.settings_stale': {
    title: 'The governance settings changed since you read them',
    body: 'The settings are no longer at the revision this request was built on. Nothing was changed.',
    next: 'Read the settings again and decide again.',
  },
  'token.role_invalid': {
    title: 'That role change is not allowed',
    body: 'The account already has that role, or a founder on this request is the account that would receive it. Nothing was changed.',
    next: 'Pick another account or role.',
  },
  'token.role_stale': {
    title: 'The role changed since you read it',
    body: 'The account is no longer at the role revision this request was built on. Nothing was changed.',
    next: 'Read the roles again and decide again.',
  },
  // svc-token launch founder doors (J-more-catalogue-14). Every one is refused before the approval is spent.
  'launch.issuer_not_onboarded': {
    title: 'This issuer is not onboarded',
    body: 'svc-token announces, snapshots or opens a launch only for an onboarded issuer. The launch status did not change.',
    next: 'Review and onboard the issuer first, then ask again.',
  },
  'launch.issuer_move_invalid': {
    title: 'The issuer cannot move to that state from where it is',
    body: 'Issuer review goes one step at a time, and a suspended issuer goes back through review. Nothing was changed.',
    next: 'Read the issuer again and pick its next step.',
  },
  'launch.issuer_conflict': {
    title: 'That issuer id is taken',
    body: 'svc-token already has an issuer with this id under another name. Nothing was changed.',
    next: 'Choose another id.',
  },
  'launch.issuer_stale': {
    title: 'The issuer changed since you read it',
    body: 'The issuer is no longer at the revision this request was built on. Nothing was changed.',
    next: 'Read the issuer again and decide again.',
  },
  'launch.issuer_not_found': {
    title: 'No such issuer',
    body: 'svc-token has no issuer with this id. Nothing was changed.',
    next: 'Add the issuer first.',
  },
  'launch.event_conflict': {
    title: 'That launch id is taken',
    body: 'svc-token already has a launch under this id with other details. Nothing was changed.',
    next: 'Choose another id.',
  },
  'launch.event_stale': {
    title: 'The launch changed since you read it',
    body: 'The launch is no longer at the revision this request was built on. Nothing was changed.',
    next: 'Read the launch again and decide again.',
  },
  'launch.event_move_invalid': {
    title: 'The launch cannot move to that status from where it is',
    body: 'A launch moves one step forward at a time, or is cancelled. Nothing was changed.',
    next: 'Read the launch again and pick its next step.',
  },
  'launch.period_not_due': {
    title: 'That period of the launch has not started',
    body: 'svc-token moves a launch only once the period for that step has begun. Nothing was changed.',
    next: 'Wait for the period, or save a new draft with other times.',
  },
  'launch.period_passed': {
    title: 'That period of the launch is over',
    body: 'The window for this step has already closed. Nothing was changed.',
    next: 'Cancel this launch or save a new draft with other times.',
  },
  'launch.allocation_unwired': {
    title: 'Allocation is not wired',
    body: 'Allocation and distribution have no ledger recipe wired, so a launch cannot move past closed. Nothing was changed.',
    next: 'This waits for the allocation recipe (MC-launch-03).',
  },
  'launch.event_invalid': {
    title: 'The launch details are not valid',
    body: 'svc-token did not accept these details. Nothing was saved.',
    next: 'Check the periods are in order and the amounts are plain decimals, then try again.',
  },
  'ops.hold_storage_unconfigured': {
    title: 'Staff holds have no storage',
    body: 'svc-ops has no database configured for staff holds, so none can be read or placed. Nothing was changed.',
    next: 'Ask whoever runs the svc-ops host to connect its database.',
  },
  'ops.hold_ledger_unconfigured': {
    title: 'svc-ops is not connected to the ledger',
    body: 'svc-ops has no ledger address or credential, so nothing can be held, released or confirmed. Nothing was changed.',
    next: 'Ask whoever runs the svc-ops host to set its ledger address.',
  },
  'ops.hold_state_illegal': {
    title: 'The hold cannot take that now',
    body: 'Either nothing is left on the hold, or another action on it is still waiting for the ledger’s answer. Nothing was changed.',
    next: 'Read the holds again, then decide on what is left.',
  },
  'ops.hold_amount_exceeds_remaining': {
    title: 'More than is held',
    body: 'The amount is more than the hold still holds, so nothing was released and the approval was not spent.',
    next: 'Read the hold again and ask for at most what is still held.',
  },
  'ops.hold_expiry_unset': {
    title: 'No longest hold expiry is set',
    body: 'The owner has not set how long a hold may last, so a hold cannot be given an expiry. Nothing was held.',
    next: 'Place it without an expiry, or ask the owner to set the longest expiry.',
  },
  'ops.hold_expiry_too_long': {
    title: 'That expiry is too long',
    body: 'The expiry is longer than the owner allows. Nothing was held.',
    next: 'Give a shorter expiry.',
  },
  'ops.idempotency_conflict': {
    title: 'A hold from this list was already asked for',
    body: 'An earlier place from this list of holds asked for a different hold, and svc-ops keeps that one. This one was not placed.',
    next: 'Read the holds again: once the list shows the earlier hold, a new one can be placed.',
  },
  'ops.hold_not_found': {
    title: 'No such hold',
    body: 'svc-ops has no hold with that number. Nothing was changed.',
    next: 'Read the holds again.',
  },
  'ledger.insufficient_funds': {
    title: 'Not enough available',
    body: 'The ledger refused: the customer does not have that much available. Nothing was moved.',
    next: 'Read the customer’s balance and ask for less.',
  },
  'ops.alert_not_found': {
    title: 'No such alert',
    body: 'svc-ops has no reconciliation alert with that id. Nothing was changed.',
    next: 'Go back to the alerts and open it again.',
  },
  'ops.alert_state_illegal': {
    title: 'The alert cannot take that now',
    body: 'The alert is no longer open or acknowledged, or it is a run that could not finish, which has no discrepancy to accept. Nothing was changed and the approval was not spent.',
    next: 'Read the alert again.',
  },
  'ops.resolve_note_required': {
    title: 'An acceptance needs a note',
    body: 'Accepting a discrepancy is recorded with a note that says why. No approval was asked for or spent, and nothing was changed.',
    next: 'Write the note (12 to 500 characters), then ask again.',
  },
  'ops.resolve_transaction_not_found': {
    title: 'The ledger never booked that transaction',
    body: 'At least one corrective transaction id is not in the ledger, so the alert was not resolved. Nothing was changed.',
    next: 'Copy the corrective transaction id from the ledger and try again.',
  },
  'ops.resolve_ledger_unavailable': {
    title: 'svc-ops could not ask the ledger',
    body: 'svc-ops could not check that the corrective transactions exist, so it resolved nothing. Nothing was changed.',
    next: 'Try again once the ledger answers.',
  },
  'action_approval.wrong_action': {
    title: 'The approval is for something else',
    body: 'The approval does not bind this exact request: another target, another note, or evidence that has changed since it was approved. Nothing was changed.',
    next: 'Read the current state and start a new request.',
  },
  'action_approval.not_founders': {
    title: 'Both people must be founders',
    body: 'This change needs two different founders, and the approval was not made by two. Nothing was changed.',
    next: 'Ask a second founder to approve a new request.',
  },
  'ops.console_read_only': {
    title: 'The console is in maintenance mode',
    body: 'Two founders turned on maintenance mode, so this console takes no writes. Reads still work, and so do the halts. Nothing was sent.',
    next: 'Wait for maintenance to end, or ask two founders to turn the mode off on Tools → Maintenance mode.',
  },
  'ops.console_mode_storage_unconfigured': {
    title: 'Maintenance mode has no storage',
    body: 'svc-ops has no database configured for the console mode, so it cannot be turned on or off, and it is never on. Nothing was changed.',
    next: 'Ask whoever runs the svc-ops host to connect its database, then start a new request.',
  },
  'ops.banner_window_invalid': {
    title: 'That window cannot be shown',
    body: 'The announcement’s window ends before it starts, or it has already ended. Nothing was published.',
    next: 'Pick a start and an end in the future, then try again.',
  },
  'ops.banner_conflict': {
    title: 'Another announcement holds that window',
    body: 'Only one announcement shows at a time, and a published one already covers part of this window. Nothing was published.',
    next: 'Withdraw the other announcement first, or pick a window that does not overlap it.',
  },
  'ops.announcement_not_found': {
    title: 'That announcement is not there',
    body: 'svc-ops has no announcement with that id. Nothing was changed.',
    next: 'Read the desk again.',
  },
  'ops.announcement_withdrawn': {
    title: 'That announcement was withdrawn',
    body: 'A withdrawn announcement stays withdrawn. Nothing was published.',
    next: 'Write a new announcement instead.',
  },
  'ops.announcement_storage_unconfigured': {
    title: 'Announcements have no storage',
    body: 'svc-ops has no database configured for console announcements, so none can be saved and none shows. Nothing was changed.',
    next: 'Ask whoever runs the svc-ops host to connect its database.',
  },
  'ops.preference_invalid': {
    title: 'That is not a value the console takes',
    body: 'A preference was not one svc-ops accepts: a time zone must be a known one such as Europe/Berlin, and a home page a console path such as /ledger. Nothing was saved.',
    next: 'Correct it and save again.',
  },
  'ops.preferences_team_unassigned': {
    title: 'No team is named for you',
    body: 'The staff directory names no team for a founder yet, so team preferences cannot be set.',
    next: 'Set the organisation’s preferences or your own instead.',
  },
  'ops.preferences_stale': {
    title: 'Someone saved these preferences first',
    body: 'Another save reached svc-ops after you opened this page, so yours was not applied. Nothing of theirs was overwritten.',
    next: 'The page now shows what is stored. Make your change again and save.',
  },
  'ops.preferences_storage_unconfigured': {
    title: 'Preferences have no storage',
    body: 'svc-ops has no database configured for console preferences, so every preference is the server’s and none can be saved.',
    next: 'Ask whoever runs the svc-ops host to connect its database.',
  },
  'ops.service_not_found': {
    title: 'That is not a platform module',
    body: 'svc-ops knows no module by that name, so it has no service page. Nothing was saved.',
    next: 'Open the module from the module health board.',
  },
  'ops.service_record_invalid': {
    title: 'That is not a value the service record takes',
    body: 'An owner team is at most 80 characters, a runbook is a path inside docs/runbooks/ ending in .md, and each dependency is another platform module, once. Nothing was saved.',
    next: 'Correct the field it names and save again.',
  },
  'ops.service_record_stale': {
    title: 'Someone saved this service record first',
    body: 'Another save reached svc-ops after you opened this page, so yours was not applied. Nothing of theirs was overwritten.',
    next: 'The page now shows what is stored. Make your change again and save.',
  },
  'ops.service_storage_unconfigured': {
    title: 'Service records have no storage',
    body: 'svc-ops has no database configured for service records, so no owner, dependency or runbook can be read or saved.',
    next: 'Ask whoever runs the svc-ops host to connect its database.',
  },
  'ops.service_owner_unset': {
    title: 'Owner not set',
    body: 'Nobody has named the team that owns this module, so no owner is shown rather than a guess.',
    next: 'Set the owner team on the module’s service page.',
  },
  'ops.service_source_unavailable': {
    title: 'One panel could not be read',
    body: 'The source behind this panel did not answer or refused, so it shows nothing in place of its data. The other panels are unaffected.',
    next: 'Reload the page to read it again.',
  },
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
  'deposit_freeze.address_unknown': {
    title: 'That is not one of this account’s deposit addresses',
    body: 'svc-pay found no deposit address of this account on that network matching it. Nothing was changed.',
    next: 'Read the account’s deposit addresses again and pick the row from there.',
  },
  'deposit_freeze.already_frozen': {
    title: 'This deposit address is already frozen',
    body: 'svc-pay already holds an open freeze on this address, so nothing new was placed. Deposits to it stay on hold.',
    next: 'Read the deposit addresses again to see the freeze, who placed it and why.',
  },
  'deposit_freeze.not_frozen': {
    title: 'This deposit address is not frozen',
    body: 'svc-pay holds no open freeze on this address, so there was nothing to lift. Nothing was changed and the approval was not used.',
    next: 'Read the deposit addresses again: if an earlier run went through and its answer was lost, the freeze is already lifted.',
  },
  'deposit_freeze.freeze_changed': {
    title: 'The freeze changed since it was read',
    body: 'The approval is for one freeze, and the address now has a different one (it was lifted and placed again), or someone lifted it first. Nothing was changed.',
    next: 'Read the deposit addresses again and make a new request for the freeze that is open now.',
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
  'identity.account_archived': {
    title: 'This customer record is archived',
    body: 'Identity keeps an archived record read-only: it cannot be frozen, unfrozen, reopened or archived again. Nothing was changed and any approval was not used.',
    next: 'Nothing to do here: an archive is not undone from the console.',
  },
  'identity.archive_blocked_open_account': {
    title: 'The account is still open',
    body: 'Identity archives only a closed account. Nothing was changed and the approval was not used.',
    next: 'Close the account first (Close or reopen), then ask again at the new control version.',
  },
  'identity.archive_requires_approver': {
    title: 'Archiving needs a second person',
    body: 'Identity archives a customer record only with an approval a different person signed. Nothing was changed.',
    next: 'Make the request, send the packet to the other founder, and run it once they approve.',
  },
  'identity.archive_approval_mismatch': {
    title: 'That approval is not for this archive',
    body: 'Identity checked the approval against this account, its current version, the reason code and the reason, and they differ, or the approval was made or signed by someone it does not accept for this account. Nothing was changed and the approval was not used.',
    next: 'Read the account again and make a new request.',
  },
  'identity.archive_approval_consumed': {
    title: 'That approval was already used',
    body: 'Identity spends an archive approval once. Nothing more was changed.',
    next: 'Read the account again; if it is not archived, make a new request.',
  },
  'identity.archive_founder_forbidden': {
    title: 'A founder record cannot be archived here',
    body: 'Identity refuses to archive either founder record from the console. Nothing was changed.',
    next: 'Nothing to do here.',
  },
  'identity.archive_self_forbidden': {
    title: 'You cannot archive your own record',
    body: 'Identity refuses an archive of the signed-in founder’s own record. Nothing was changed.',
    next: 'Nothing to do here.',
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
  'identity.limit_ceiling_unset': {
    title: 'No limit override policy is set',
    body: 'The owner has not set the limit override policy (IDENTITY_LIMIT_OVERRIDE_POLICY) for this rail and asset: the longest an override may last and the ceiling above which it needs the other founder. Identity sets no override without it. Nothing was changed.',
    next: 'The owner sets the policy; nothing here fills it in.',
  },
  'identity.limit_expiry_past': {
    title: 'That end time has already passed',
    body: 'An override must end after now. Nothing was changed.',
    next: 'Choose a later end time.',
  },
  'identity.limit_lifetime_exceeded': {
    title: 'That override would last too long',
    body: 'The owner’s policy caps how long an override may last, and this one ends after that. Nothing was changed.',
    next: 'Choose an end time within the longest lifetime shown.',
  },
  'identity.limit_unchanged': {
    title: 'That override is already in force',
    body: 'The same figures and end time are already set. Nothing was changed.',
    next: 'Read the account again.',
  },
  'identity.limit_self_forbidden': {
    title: 'You cannot change your own limits',
    body: 'A founder does not override the limits of their own account. Nothing was changed.',
    next: 'The other founder can make the change.',
  },
  'identity.limit_account_closed': {
    title: 'The account is closed',
    body: 'Identity sets no limit override on a closed account. Nothing was changed.',
    next: 'Reopen the account first if that is allowed.',
  },
  'identity.limit_requires_approver': {
    title: 'Above the ceiling, a second founder must approve',
    body: 'This override goes above the owner’s ceiling for its rail and asset, so identity sets it only with the other founder’s approval. Nothing was changed.',
    next: 'Ask the other founder to approve the request, then run it.',
  },
  'identity.limit_approval_mismatch': {
    title: 'That approval is not for this override',
    body: 'The approval does not match this account, rail, asset, figures, end time, reason or override version, was not approved by a different founder who is still a founder, or has expired. Nothing was changed.',
    next: 'Read the account again and make a new request if it still needs doing.',
  },
  'identity.limit_approval_consumed': {
    title: 'That approval was already used',
    body: 'An approval runs once. Nothing was changed by this attempt.',
    next: 'Read the account again: if an earlier run went through and its answer was lost, the override is already there. If it still needs doing, make a new request.',
  },
  'identity.limit_override_not_found': {
    title: 'No override is in force',
    body: 'There is no override of this rail and asset to end. The base limit applies. Nothing was changed.',
    next: 'Read the account again.',
  },
  'identity.limit_override_expired': {
    title: 'That override has already ended',
    body: 'Its stored end time has passed, so the base limit applies again. Nothing was changed.',
    next: 'Read the account again.',
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
  'drop.wave_unset': {
    title: 'The wave size is not set',
    body: 'Nobody can be released until the owner sets how many people one waitlist wave releases (IDENTITY_WAITLIST_WAVE_SIZE). Nothing was released and no approval was spent.',
    next: 'Ask the owner to set the wave size in the identity service settings, then start a new request.',
  },
  'waitlist.wave_unknown': {
    title: 'That is not the next wave',
    body: 'Waves are released in order, and another release may have landed since you read the desk. Nothing was released.',
    next: 'Read the waves below and request the wave number shown as next.',
  },
  'waitlist.wave_empty': {
    title: 'Nobody is waiting',
    body: 'Every person on the waitlist has already been released, so there is nobody to invite. Nothing was released.',
    next: 'Read the waves below. Release again once more people have joined.',
  },
  'waitlist.unbuilt': {
    title: 'The waitlist is not connected',
    body: 'Identity has no waitlist store on this host, so no wave can be released. Nothing was released.',
    next: 'Ask whoever runs the identity host to connect the waitlist database, then start a new request.',
  },
  'flag.waitlist.enabled.disabled': {
    title: 'The waitlist is switched off',
    body: 'The waitlist.enabled switch is off, so identity releases no wave. Nothing was released.',
    next: 'Turn the waitlist back on first, then start a new request.',
  },
  'flag.waitlist.enabled.drop_pending': {
    title: 'The waitlist has not opened yet',
    body: 'The waitlist.enabled switch is waiting for its launch drop, so identity releases no wave yet. Nothing was released.',
    next: 'Release once the waitlist is open.',
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
  'kyc_doc.unwired': {
    title: 'Identity’s document vault is switched off',
    body: 'Its encryption key (IDENTITY_KYC_DOC_KEY) is not set on this deployment, so no document can be stored, listed or opened. Nothing was read.',
    next: 'The key is an owner setting. Ask engineering to set it.',
  },
  'kyc_doc.not_found': {
    title: 'Identity holds no such document',
    body: 'The document is not in identity’s vault (it may have been deleted), so nothing was shown. Identity spent the approval on the attempt.',
    next: 'Read the account’s document list again; opening another document needs a new request.',
  },
  'kyc_doc.reviews_unwired': {
    title: 'Identity cannot say which verification each document belongs to',
    body: 'Its document vault is on, but the lookup of each document’s verification is not wired on this deployment, so identity refuses the list rather than show every document as not attached.',
    next: 'Tell engineering: identity’s boot is missing the document review lookup.',
  },
  'kyc_doc.reader_not_requester': {
    title: 'Only the founder who asked can open this document',
    body: 'Identity opens a document only for the person who made the request, never for the approver or anyone else holding the packet. Nothing was shown.',
    next: 'The founder who asked runs it on their own console.',
  },
  'kyc_doc.decrypt_failed': {
    title: 'Identity could not decrypt the document',
    body: 'Its stored contents do not open with the vault’s key, so nothing is shown. The approval may have been spent.',
    next: 'Tell engineering: the vault key or the stored document is damaged.',
    changed: 'unknown',
  },
  'kyc.selfie_unconfigured': {
    title: 'Identity’s selfie step is switched off',
    body: 'The selfie step is not configured on this deployment, so no selfie can be taken, listed or decided. Nothing was changed.',
    next: 'Ask engineering to switch on identity’s selfie step.',
  },
  'kyc.selfie_unknown': {
    title: 'Identity holds no such selfie',
    body: 'The selfie is not there any more: the person may have taken a new one, which replaces a selfie nobody has decided. Nothing was decided.',
    next: 'Read the account’s selfies again and decide the one that waits; that needs a new request.',
  },
  'kyc.selfie_decided': {
    title: 'This selfie was already decided',
    body: 'A selfie is decided once. Identity kept the decision it already holds and refused this one.',
    next: 'Read the account’s selfies again to see the decision on record.',
  },
  'auth.kyc_self_review': {
    title: 'Nobody may decide their own verification',
    body: 'Identity refused because you, or a founder on the approval, are the person this verification belongs to. Nothing was decided.',
    next: 'Two other founders ask for and approve the decision.',
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
  'ops.control_state_illegal': {
    title: 'Only an active control can run',
    body: 'svc-ledger refused before it read anything or used the approval: this control is still a draft.',
    next: 'Activate the control first. Activating changes its version, so ask for a new approval after that.',
  },
  'ops.control_margin_unset': {
    title: 'A run at a past instant needs a margin',
    body: 'Neither the request nor the control names how many seconds before the instant to read, so nothing ran.',
    next: 'Type a margin (0 is accepted) or set one on the control, then ask for a new approval.',
  },
  'ops.control_policy_unset': {
    title: 'The control is missing a policy value',
    body: 'Tolerance, schedule and severity are needed (a threshold control also needs a threshold per asset), so it was not activated.',
    next: 'Fill in the blank values. Nothing was changed.',
  },
  'ledger.frozen': {
    title: 'The ledger is frozen',
    body: 'The posting freeze is on, so svc-ledger takes no write, metadata included. Reads still work. Nothing was changed, and an approval was not used.',
    next: 'Wait for the freeze to be lifted, then try again with the same approval.',
  },
  'ledger.account_metadata_stale': {
    title: 'That key changed since you read it',
    body: 'Someone else set or deleted this key after it was read, so svc-ledger changed nothing.',
    next: 'Read the account again, and ask for a new approval if this was a delete.',
  },
  'ledger.account_metadata_approval_spent': {
    title: 'The approval was used, but nothing was deleted',
    body: 'The posting freeze or another change to this key landed in the moment svc-ledger was writing the delete, so it changed nothing. Identity had already spent the approval.',
    next: 'Read the account again, then ask a second founder for a new approval.',
  },
  'ledger.account_metadata_key_absent': {
    title: 'That key holds no value',
    body: 'svc-ledger has no value under this key on the account, so there was nothing to delete.',
    next: 'Read the account again.',
  },
  'ledger.account_not_found': {
    title: 'No ledger account has that id',
    body: 'svc-ledger has no account with that id, so nothing was read or changed.',
    next: 'Search the account address again.',
  },
  'ledger.account_metadata_invalid': {
    title: 'The key, value or reason was refused',
    body: 'A key is lower case (a letter, then letters, digits, _ . : or -, 64 at most), a value is 1 to 500 characters and a reason 12 to 500. Nothing was changed.',
    next: 'Correct it and try again.',
  },
  'ledger.reconcile_asof_invalid': {
    title: 'That instant is in the future',
    body: 'A control reads only the past, so svc-ledger refused before it read anything or used the approval.',
    next: 'Choose a past instant and ask for a new approval.',
  },
  'ledger.reconcile_control_not_found': {
    title: 'No control has that id',
    body: 'svc-ledger has no reconciliation control with that id, so nothing ran.',
    next: 'Read the controls again.',
  },
  'ledger.reconcile_builtin_immutable': {
    title: 'Built-in controls cannot be changed',
    body: 'The three built-in controls cover the whole book and cannot be changed or removed. Nothing was changed.',
    next: 'Define a new control instead.',
  },
  'ledger.reconcile_source_unavailable': {
    title: 'svc-ledger could not reach its book',
    body: 'The control could not be read or run. A result row may already exist for this run.',
    next: 'Read the controls again before repeating anything.',
    changed: 'unknown',
  },
  'ledger.idempotency_conflict': {
    title: 'This approval was used for a different run',
    body: 'svc-ledger keeps one run per approval. The same operation with another reason, instant or margin is refused, and nothing new ran.',
    next: 'Ask for a new approval.',
  },
  'edge.invalid_reconciliation_control': {
    title: 'The request was refused for its shape',
    body: 'svc-edge checked it against the contract and refused it before the ledger was called. The approval was not used.',
    next: 'Tell engineering: the console and the edge disagree about the contract.',
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
  'status.rate_limit_unset': {
    title: 'The subscribe rate limit is blank',
    body: 'svc-notify takes no subscriber, from /status or an import, until a founder sets how many requests an address may make an hour. Nothing was stored.',
    next: 'Set the rate limit under Safeguards, then try again.',
  },
  'status.challenge_unset': {
    title: 'The subscribe safeguards are not set',
    body: 'The proof of work strength is blank, or this deployment has no link key, so svc-notify takes no subscriber. Nothing was stored.',
    next: 'Set the proof of work strength under Safeguards. A missing link key is a deployment setting.',
  },
  'status.rate_limited': {
    title: 'Too many requests for that address',
    body: 'The address asked more often this hour than the rate limit allows. Nothing more was sent to it.',
    next: 'Wait for the hour to pass.',
  },
  'status.import_invalid': {
    title: 'That import is not complete',
    body: 'An import names its source (lowercase letters, digits and dashes) and holds 1 to 500 addresses. Nothing was stored.',
    next: 'Correct it and import again.',
  },
  'status.notice_unknown': {
    title: 'That notice is not published',
    body: 'Only a published notice has deliveries to send again. Nothing was sent.',
    next: 'Read the desk again and pick a published notice.',
  },
  'notify.notice_audience_invalid': {
    title: 'That audience is not one an announcement can have',
    body: 'An announcement is for everyone, or for P2P merchants only. Incidents, maintenance and changelog entries are always for everyone. Nothing was saved.',
    next: 'Choose everyone or P2P merchants.',
  },
  'status.category_unknown': {
    title: 'That category is not on the list',
    body: "An announcement may name only a category on the founders' list, and none while no list is set. Nothing was saved.",
    next: 'Choose a category from the list, or none, or set the list first.',
  },
  'status.maintenance_illegal_move': {
    title: 'That move does not follow',
    body: 'A window goes from in progress to verifying, then to completed, and is cancelled only before it is verifying. Scheduled and in progress follow from its start. Nothing was changed.',
    next: 'Read the desk again and make the move that follows.',
  },
  'status.maintenance_reopen_refused': {
    title: 'A finished window does not reopen',
    body: 'This window is completed or cancelled, which is final. Nothing was changed.',
    next: 'If the work is needed again, schedule a new window.',
  },
  'status.maintenance_unknown': {
    title: 'That is not a published maintenance window',
    body: 'Moves are made on published windows only. Nothing was changed.',
    next: 'Publish the window first, or read the desk again.',
  },
  'status.maintenance_reason_unset': {
    title: 'Say why',
    body: 'Every move on a window is recorded with its reason, 1 to 500 characters. Nothing was changed.',
    next: 'Write the reason and try again.',
  },
  'notify.notice_reminders_invalid': {
    title: 'Those reminders do not fit',
    body: 'Reminders belong to a maintenance window with a start: whole minutes from 1 to 43200 before it, at most 10. Nothing was saved.',
    next: 'Correct the offsets, or leave them blank for none.',
  },
  'status.postmortem_requires_resolved': {
    title: 'The incident is not resolved yet',
    body: 'A postmortem is the account of an incident that is over, so svc-notify takes one only once a published update has resolved it. Nothing was saved.',
    next: 'Resolve the incident first, then write the postmortem.',
  },
  'status.postmortem_incident_unknown': {
    title: 'That is not a published incident',
    body: 'A postmortem goes on the first entry of a published incident. Nothing was saved.',
    next: 'Read the desk again and pick the incident.',
  },
  'status.postmortem_invalid': {
    title: 'That postmortem is not complete',
    body: 'A postmortem is 1 to 20000 characters. Nothing was saved.',
    next: 'Correct it and save again.',
  },
  'status.postmortem_version_stale': {
    title: 'The postmortem changed since you read it',
    body: 'Another founder saved a newer version first, or the version an approval was asked for moved on. Nothing was changed.',
    next: 'Read the desk again, then edit the version shown.',
  },
  'status.postmortem_published': {
    title: 'The postmortem is published',
    body: 'A published postmortem is never edited. Nothing was changed.',
    next: 'Nothing to do.',
  },
  'status.postmortem_not_found': {
    title: 'No postmortem is written for this incident',
    body: 'There is no draft to ask an approval for or to publish. Nothing was changed.',
    next: 'Write the postmortem first.',
  },
  'status.postmortem_approval_spent': {
    title: 'That approval cannot publish this postmortem',
    body: 'It was already spent, or it was asked for another version or wording. Nothing was published.',
    next: 'Ask for a new approval for the postmortem as it stands now.',
  },
  'status.postmortem_approval_unavailable': {
    title: 'Approvals are not connected',
    body: 'svc-notify has no connection to identity approvals, so it publishes no postmortem. Nothing was published.',
    next: 'Connect svc-notify to svc-identity (IDENTITY_URL and the internal service secret).',
  },
  'status.postmortem_approval_unreachable': {
    title: 'Identity did not answer',
    body: 'svc-notify could not reach identity to spend the approval, or could not read its answer. Nothing was published, and the approval was not refused here.',
    next: 'Read the desk again and publish again with the same approval.',
  },
  'status.postmortem_publish_same_operator': {
    title: 'The approver cannot also publish',
    body: 'The founder who approved a postmortem does not publish it. svc-notify spent the approval and published nothing.',
    next: 'Ask for a new approval; the founder who asked publishes it after another founder approves.',
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
  'academy.slug_reserved': {
    title: 'That address is an Academy tab',
    body: 'learning, certificates, rooms, videos, programmes and progress are the Academy’s own tabs, so no course or topic can use one.',
    next: 'Choose another address. Nothing was saved.',
  },
  'academy.course_slug_taken': {
    title: 'That address is taken',
    body: 'Another course, a shipped course or a lesson already uses this address.',
    next: 'Choose another address. Nothing was saved.',
  },
  'academy.course_revision_stale': {
    title: 'The course changed since you opened it',
    body: 'Someone saved or moved this course after you read it, so your change was not applied.',
    next: 'Read the course again and decide again. Nothing was changed.',
  },
  'academy.course_not_editable': {
    title: 'Only a draft is edited here',
    body: 'This course is no longer a draft, so its details are not changed from this form.',
    next: 'Nothing was changed.',
  },
  'academy.item_transition_illegal': {
    title: 'That move is not open from this state',
    body: 'The course is not in a state this move starts from.',
    next: 'Read the course again. Nothing was changed.',
  },
  'academy.price_unset': {
    title: 'A paid course needs a price',
    body: 'This course is paid and has no price, so it was not published.',
    next: 'Set a price and its asset, save, then publish. Nothing was changed.',
  },
  'academy.course_outline_empty': {
    title: 'The course has nothing in it yet',
    body: 'Its outline has no sections or items, so there is nothing for a learner to open and it was not published.',
    next: 'Build the outline first. Nothing was changed.',
  },
  'academy.outline_limits_unset': {
    title: 'The outline limits are not set',
    body: 'The owner has not set how many sections and items a course outline may hold, so no outline is saved.',
    next: 'The owner sets both limits for this deployment. Nothing was saved.',
  },
  'academy.outline_too_large': {
    title: 'The outline is over the limit',
    body: 'It has more sections or items than the owner allows for one course.',
    next: 'Remove some, then save again. Nothing was saved.',
  },
  'academy.outline_item_unknown': {
    title: 'The outline changed since you opened it',
    body: 'Your outline names a section or item this course no longer holds.',
    next: 'Read the course again and redo your change. Nothing was saved.',
  },
  'academy.revision_stale': {
    title: 'The lesson changed since you opened it',
    body: 'Someone saved this lesson after you read it, so your change was not applied.',
    next: 'Read the lesson again and decide again. Nothing was changed.',
  },
  'academy.lesson_revision_unknown': {
    title: 'No such lesson revision',
    body: 'This lesson has no revision with that number.',
    next: 'Read the lesson again. Nothing was changed.',
  },
  'academy.item_has_no_lesson': {
    title: 'This item holds no lesson',
    body: 'A subheader is a label and a link opens its address, so neither has lesson content.',
    next: 'Write the lesson on another item. Nothing was changed.',
  },
  'academy.item_kind_locked': {
    title: 'This item has a lesson',
    body: 'An item with lesson revisions stays a type that holds a lesson, so it does not become a subheader or a link.',
    next: 'Add a new subheader or link instead. Nothing was saved.',
  },
  'academy.import_limit_unset': {
    title: 'The import size limit is not set',
    body: 'The owner has not set the largest lesson file the desk imports, so no file is imported.',
    next: 'The owner sets the limit for this deployment. Nothing was read or created.',
  },
  'academy.import_too_large': {
    title: 'The file is over the size limit',
    body: 'This lesson file is larger than the owner allows, so it was refused before it was read.',
    next: 'Split the lesson or shorten it. Nothing was created.',
  },
  'academy.draft_not_found': {
    title: 'No such draft',
    body: 'This lesson has no open assistant draft by that name, or it was already decided the other way.',
    next: 'Read the lesson again. Nothing was changed.',
  },
  'academy.lesson_blocks_invalid': {
    title: 'Lesson does not fit',
    body: 'A block of this lesson is over the lesson format’s limits, so it was refused before it was stored.',
    next: 'Shorten the lesson or split the section, then try again. Nothing was changed.',
  },
  'academy.assignment_not_found': {
    title: 'Not an assignment',
    body: 'This item is not an assignment, or it has no brief to change.',
    next: 'Read the course again. Nothing was changed.',
  },
  'academy.quiz_not_found': {
    title: 'Not a quiz',
    body: 'This outline item is not a quiz, so it has no questions or attempt rules.',
    next: 'Read the course again. Nothing was changed.',
  },
  'academy.quiz_no_questions': {
    title: 'The quiz has no questions',
    body: 'A quiz with no questions is not published, because there is nothing to take.',
    next: 'Add at least one question and save, then publish. Nothing was published.',
  },
  'academy.pass_mark_unset': {
    title: 'The pass mark is not set',
    body: 'Learners could not be marked passed or failed, so a quiz with no pass mark is not published. A pass mark of 0 means taking it completes it.',
    next: 'Set the pass mark and save, then publish. Nothing was published.',
  },
  'academy.scoring_policy_unset': {
    title: 'No scoring policy for more than one attempt',
    body: 'This quiz allows more than one attempt, so it needs to say which attempt counts: highest, latest, first or average.',
    next: 'Choose a scoring policy, or allow one attempt, and save. Nothing was published.',
  },
  'academy.item_has_attempts': {
    title: 'Learners have taken this quiz',
    body: 'A quiz with attempts keeps its questions and stays published, so every attempt is read against what was asked.',
    next: 'Its rules can still change. To ask different questions, add a new quiz item. Nothing was changed.',
  },
  'academy.assessment_invalid': {
    title: 'The quiz does not add up',
    body: 'svc-academy found this quiz inconsistent: for example a pass mark above the questions’ points together, an essay score above its question’s points, or an access code or IP filter on a survey.',
    next: 'Check the pass mark, points, answers and scores, then try again. Nothing was saved.',
  },
  'academy.attempt_closed': {
    title: 'Already scored',
    body: 'This attempt is not waiting for an essay score any more: it was scored already.',
    next: 'Read the quiz again. Nothing was changed.',
  },
  'academy.prerequisite_cycle': {
    title: 'That would make a loop',
    body: 'With this set, an item would end up requiring itself, directly or through other items, so no learner could open any of them.',
    next: 'Remove one of the items that leads back. Nothing was saved.',
  },
  'academy.window_invalid': {
    title: 'That date or window does not work',
    body: 'Academy found the dates out of order: for example a learner’s own due date not after the assignment’s, an assignment with no due date to move, or a window that ends before it starts.',
    next: 'Check the dates and try again. Nothing was saved.',
  },
  'academy.enrolment_required': {
    title: 'Not enrolled',
    body: 'That account is not enrolled in this course.',
    next: 'Check the learner’s account id. Nothing was changed.',
  },
  'academy.weights_invalid': {
    title: 'The weights do not add up to 1',
    body: 'The weights of all the types together must come to exactly 1, for example 0.6 and 0.4.',
    next: 'Change the weights so they add up to 1. Nothing was saved.',
  },
  'academy.grading_policy_invalid': {
    title: 'The grading policy does not fit the course',
    body: 'Each item may sit in one type only, a type may not drop every score it holds, two types may not share a name, and only the course’s assignments and graded quizzes count.',
    next: 'Correct the types and save again. Nothing was saved.',
  },
  'academy.prerequisite_unmeasured': {
    title: 'That item cannot be required',
    body: 'A lesson, video, file or link records no completion on a course staff made, so no learner could ever meet it.',
    next: 'Require an assignment or a quiz instead. Nothing was saved.',
  },
  'academy.pacing_locked': {
    title: 'Pacing is fixed',
    body: 'Learners have enrolled in this course, so its pacing stays as it was when they joined.',
    next: 'Section release dates can still change. Nothing was changed.',
  },
  'academy.not_released_yet': {
    title: 'Not open yet',
    body: 'This section is scheduled and has not opened for this learner yet.',
    next: 'It opens at the time shown. Nothing was changed.',
  },
  'academy.attempt_not_found': {
    title: 'No such attempt',
    body: 'This attempt is not on record.',
    next: 'Read the quiz again. Nothing was changed.',
  },
  'academy.ip_rule_invalid': {
    title: 'An IP filter entry is not an address',
    body: 'Each entry is one address or a CIDR range, such as 203.0.113.7 or 203.0.113.0/24.',
    next: 'Correct the entry and save. Nothing was saved.',
  },
  'academy.assignment_closed': {
    title: 'Assignment withdrawn',
    body: 'This assignment was withdrawn, so its brief is not edited and learners hand in nothing more.',
    next: 'Nothing was changed. What learners handed in stays readable to them.',
  },
  'academy.grader_locked': {
    title: 'Another grader holds this hand-in',
    body: 'Someone else opened this hand-in for grading and their hold has not run out, so two grades never cross.',
    next: 'Grade another hand-in, or try this one again later. Nothing was changed.',
  },
  'academy.grader_lease_unset': {
    title: 'The grader hold time is not set',
    body: 'The owner has not set how long a grader holds a hand-in, so no hand-in is graded.',
    next: 'Ask the owner to set the grader hold time. Nothing was changed.',
  },
  'academy.bulk_file_invalid': {
    title: 'That grade file cannot be read',
    body: 'A grade file is a CSV whose first line is learner,score,comment,reason, with at least one row below it.',
    next: 'Correct the file and upload it again. Nothing was changed.',
  },
  'academy.permission_denied': {
    title: 'This needs a role you do not hold',
    body: 'Answer-level quiz data needs the data researcher role on the course. Academy has no course roles to hold, so no account holds it.',
    next: 'Read the item analysis and score distribution instead. Nothing was changed.',
  },
  'academy.bulk_limit_unset': {
    title: 'The curve file limit is not set',
    body: 'The owner has not set how large a curve file may be, so no curve file is read.',
    next: 'Ask the owner to set the curve file limit. Nothing was changed.',
  },
  'academy.bulk_file_too_large': {
    title: 'That file is over the limit',
    body: 'The file is larger than the owner allows for one curve file, so it was refused before it was read.',
    next: 'Split the file and upload each part. Nothing was changed.',
  },
  'academy.key_fix_invalid': {
    title: 'That is not a key fix',
    body: 'A key fix changes only the answer keys of a published quiz: every question stays, with its wording, choices and points.',
    next: 'Change only keys, or make a new quiz for other changes. Nothing was changed.',
  },
  'academy.grade_invalid': {
    title: 'That score is above the points',
    body: 'A score runs from 0 to the assignment’s points, with at most two decimals.',
    next: 'Correct the score and save again. Nothing was changed.',
  },
  'academy.reason_required': {
    title: 'A reason is needed',
    body: 'Changing a grade that was already saved is an override, and an override keeps its reason.',
    next: 'Say why the grade changes, then save again. Nothing was changed.',
  },
  'academy.submission_not_found': {
    title: 'Not a hand-in to grade',
    body: 'This is not the newest hand-in of a learner on this assignment.',
    next: 'Read the queue again. Nothing was changed.',
  },
  'academy.peer_count_unset': {
    title: 'Peer review has no review count',
    body: 'Peer review is on, but how many classmates each learner reviews is not set, so learners could not be handed work.',
    next: 'Set the number of reviews each learner gives, or turn peer review off. Nothing was changed.',
  },
  'academy.rubric_invalid': {
    title: 'The rubric is not complete',
    body: 'A peer or self review is scored against a rubric: at least one criterion, each with its own name.',
    next: 'Add a criterion or rename one of the two alike. Nothing was changed.',
  },
  'academy.assignment_has_submissions': {
    title: 'Learners handed in to this assignment',
    body: 'An assignment learners handed in to stays in the outline, so their work stays readable.',
    next: 'Withdraw the assignment from its page instead. The outline was not saved.',
  },
  'academy.upload_limits_unset': {
    title: 'The upload limits are not set',
    body: 'The owner has not set the largest file the desk uploads, or the video or handout types it accepts, so no file is uploaded.',
    next: 'The owner sets the limits for this deployment. Nothing was sent.',
  },
  'academy.upload_too_large': {
    title: 'The file is over the size limit',
    body: 'This file is larger than the owner allows, so no upload address was issued.',
    next: 'Choose a smaller file. Nothing was sent.',
  },
  'academy.upload_type_refused': {
    title: 'This file type is not accepted',
    body: 'The owner does not accept this type for this kind of file, or its content cannot be checked.',
    next: 'Choose a file of an accepted type. Nothing was sent.',
  },
  'academy.file_type_mismatch': {
    title: 'The file is not what it says it is',
    body: 'svc-academy read the stored file back and its content is not the type it was declared as, so it was refused.',
    next: 'Upload the file as the type it really is. Learners never see a refused file.',
  },
  'academy.upload_incomplete': {
    title: 'The file has not fully arrived',
    body: 'Storage does not hold the whole file yet, so it was not checked.',
    next: 'Send the file again. Nothing was published.',
  },
  'academy.media_not_found': {
    title: 'No such upload',
    body: 'svc-academy has no upload with this id.',
    next: 'Read the item again. Nothing was changed.',
  },
  'academy.video_storage_unconfigured': {
    title: 'File storage is not set up',
    body: 'This deployment has no object store for course files, so nothing can be uploaded.',
    next: 'The owner sets up storage for this deployment. Nothing was sent.',
  },
  'academy.item_video_missing': {
    title: 'Upload the video first',
    body: 'Captions belong to a video, and this item has no checked video yet.',
    next: 'Upload and check the video, then add its captions. Nothing was saved.',
  },
  'academy.featured_not_live': {
    title: 'Learners cannot read this lesson',
    body: 'Only a lesson with a revision published to learners is featured on the Learn hub.',
    next: 'Publish a revision to learners first. Nothing was featured.',
  },
  'academy.lesson_not_live': {
    title: 'Learners see nothing here already',
    body: 'No revision of this lesson is published to learners, so there is nothing to withdraw.',
    next: 'Read the lesson again. Nothing was changed.',
  },
  'academy.private_link_not_found': {
    title: 'No such private link',
    body: 'svc-academy holds no private link with that id.',
    next: 'Read the course again. Nothing was changed.',
  },
  'academy.private_link_course_closed': {
    title: 'This course takes no private link',
    body: 'The course is archived or deleted, so a private link would open nothing.',
    next: 'Nothing was made.',
  },
  'academy.topic_not_found': {
    title: 'No such topic',
    body: 'One of the chosen topics is not on the Learn hub’s topic list.',
    next: 'Read the course again and pick from the list. Nothing was saved.',
  },
  'academy.topic_slug_taken': {
    title: 'That address is taken',
    body: 'Another topic already has this address under a different name.',
    next: 'Choose another address. Nothing was added.',
  },
  'academy.topics_list_limit_unset': {
    title: 'The topic list limit is not set',
    body: 'The owner has not set how many topics a list shows, so the list is not read.',
    next: 'The owner sets the limit for this deployment.',
  },
  'owner.decision': {
    title: 'Waiting for an owner decision',
    body: 'This path needs a choice the owner has not made yet, so it is off. Nothing was sent anywhere.',
    next: 'Use the path that works now, or ask the owner to decide. Nothing was changed.',
  },
  'academy.course_not_found': {
    title: 'No such course',
    body: 'svc-academy has no course with this id.',
    next: 'Go back to the course list. Nothing was changed.',
  },
  'academy.report_limit_unset': {
    title: 'The report size is not set',
    body: 'The owner has not set how many learner rows one grade report may hold, so no report is made.',
    next: 'The owner sets the limit for this deployment. Nothing was made.',
  },
  'academy.report_too_large': {
    title: 'Too many learners for one report',
    body: 'This course has more enrolled learners than one grade report may hold.',
    next: 'Ask the owner to raise the report size. Nothing was made.',
  },
  'academy.report_out_of_order': {
    title: 'That report number skips one',
    body: 'Reports of a course are numbered one after another, and this number is past the next one.',
    next: 'The list below is read again. Make the next report from it. Nothing was made.',
  },
  'academy.report_not_found': {
    title: 'No such report',
    body: 'This course has no stored grade report with that number.',
    next: 'Pick a report from the list. Nothing was made.',
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
 * explain it. A bracketed code is identity's own and wins over the wrapper's: svc-ops sends
 * `action_approval.identity_unwired — identity refused consume (412) ... [action_approval.not_approved]` for any refusal, and
 * the founder must read "not approved yet", not "not connected". Otherwise the first known `action_approval.*` code, or null.
 */
export function codeInText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const match of text.matchAll(/\[(action_approval\.[a-z_]+)\]/g)) if (isKnownCode(match[1])) return match[1];
  for (const match of text.matchAll(/\b(action_approval\.[a-z_]+)\b/g)) if (isKnownCode(match[1])) return match[1];
  // svc-pay's deposit address freezes put their code first: `deposit_freeze.not_frozen: …`.
  const freeze = /^(deposit_freeze\.[a-z_]+):/.exec(text)?.[1];
  if (freeze && isKnownCode(freeze)) return freeze;
  return null;
}
