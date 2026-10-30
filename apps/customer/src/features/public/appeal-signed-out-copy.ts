import { defineCopy } from '../../shared/i18n';

const messages = {
  eyebrow: 'ACCOUNT STATUS',
  title: 'Appeal a freeze',
  intro:
    'Your account is frozen, so you cannot sign in. Only support can lift a freeze. If our staff froze it and you think that is wrong, ask us to look again: someone other than the person who froze it decides, and we mail you the decision.',
  identifier: 'Email or handle',
  password: 'Password',
  passwordHint: 'Your account password proves the appeal is yours. It does not sign you in.',
  text: 'Why should the freeze be lifted?',
  textHint: 'Up to {max} characters. Only our staff read this.',
  missing: 'Fill in your email or handle, your password and why you are appealing.',
  send: 'Send appeal',
  sending: 'Sending…',
  sentTitle: 'Your appeal was sent',
  sentBody: 'We will mail you the decision. While it waits, the freeze stays and you cannot sign in.',
  status_submitted: 'Waiting for a decision',
  status_in_review: 'Being reviewed',
  status_upheld: 'Upheld: the freeze stays',
  status_lifted: 'Lifted: you can sign in again',
  status_withdrawn: 'Withdrawn',
  'refused_identity.appeal_open': 'You already have an appeal waiting for this freeze. Only one can be open at a time.',
  'refused_identity.appeal_window_unset': 'Appeals are closed: no appeal window is set, so an appeal cannot be sent.',
  'refused_identity.appeal_window_closed': 'The time to appeal this freeze has passed.',
  'refused_identity.appeal_no_restriction': 'This account is not frozen by support, so there is nothing to appeal here.',
  'refused_identity.appeal_setter_unknown':
    'This freeze cannot be appealed here, because we have no record of a staff member setting it. Contact support.',
  'refused_identity.appeal_sign_in': 'This account is not frozen. Sign in, and appeal any restriction from your account status.',
  'refused_identity.appeal_not_allowed': 'A closed account cannot be appealed here. Contact support if you have questions.',
  'refused_identity.appeal_request_conflict': 'This appeal was already sent with other words. Reload the page.',
  refusedOther: 'The appeal was not sent.',
  signIn: 'Sign in',
  help: 'Contact support',
} as const;

export const appealSignedOutCopy = defineCopy('public.appeal', messages);
