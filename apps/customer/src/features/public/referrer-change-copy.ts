import { defineCopy } from '../../shared/i18n';

/** A reviewed change of referrer (CM-referral-01, J-campaigns-05 #5 and #6). */
export const referrerChangeCopy = defineCopy('public.referrerChange', {
  title: 'Referrer change review',
  offerTitle: 'Ask for a review instead',
  offerBody:
    'This link cannot attach a referrer to your account now. You can ask our team to attach you to the person who sent it. A second person reviews the request; until then nothing changes.',
  reasonLabel: 'Why should the person who sent this link become your referrer?',
  reasonHelp: 'Between 3 and 500 characters. The reviewer reads it.',
  submit: 'Request a review',
  sending: 'Sending the request…',
  none: 'No referrer change request on this account.',
  submitted: 'Your request is saved and waiting to be filed for review.',
  under_review: 'Your request is waiting for a second person to review it. The review closes at {reviewEndsAt}.',
  approved: 'Approved. The new referrer applies from {appliedAt}. Earlier commission records stay as they were.',
  rejected: 'Not approved. Your referrer did not change.',
  withdrawn: 'You withdrew this request. Nothing changed.',
  expired: 'The review time ended before a decision. Nothing changed. You can ask again.',
  decisionReason: 'Reviewer’s reason',
  yourReason: 'Your reason',
  toReferrer: 'Requested referrer ID',
  requested: 'Requested',
  withdraw: 'Withdraw this request',
  refused: 'The request was refused. Nothing was sent for review.',
  rebindOpen: 'You already have an open request for a different referrer. Withdraw it first or wait for its review.',
  rebindNotNeeded: 'Your account can still attach a referrer through the link itself, so no review is needed.',
  sameReferrer: 'This person is already your referrer.',
  revoked: 'This invitation link was revoked, so it cannot name a referrer.',
  reviewUnset: 'No review can be filed: the owner has not set how long a review stays open.',
});
