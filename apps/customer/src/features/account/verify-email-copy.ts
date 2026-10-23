import { defineCopy } from '../../shared/i18n';

const messages = {
  label: 'Email address',
  verified: 'Your email address is verified.',
  title: 'Verify your email address',
  body: 'Prove this address is yours. We send a link to the email on this account; open it and press Confirm.',
  send: 'Send confirmation email',
  sending: 'Sending…',
  sent: 'If this address can receive mail, a confirmation link is on its way. It works once and runs out after a while. Open it, then come back here.',
  check: 'I opened the link: check again',
  checking: 'Checking…',
  unread: 'We could not check your address just now. Your link still works; try again in a moment.',
  stillUnverified: 'This address is still unverified. Open the newest link from the email, or send a new one.',
  'auth.email_confirm_rate_limited': 'You asked for several emails already. You can ask again in {minutes} min.',
  'auth.email_confirm_rate_limited_plain': 'You asked for several emails already. Wait a while, then ask again.',
  'auth.email_confirm_unwired':
    'Email delivery is switched off in this build, so a confirmation link cannot be sent. Your address stays unverified.',
} as const;

export const verifyEmailCopy = defineCopy('account.verify-email', messages);
