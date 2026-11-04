import { defineCopy } from '../../shared/i18n';

const messages = {
  label: 'Email address',
  verified: 'Your email address is verified.',
  title: 'Verify your email address',
  body: 'Prove this address is yours. We send a 6-digit code to the email on this account; type it here. The email also has a link that does the same.',
  send: 'Send confirmation email',
  sending: 'Sending…',
  sent: 'If this address can receive mail, a confirmation code is on its way, with a link that does the same. It works once and runs out after a while.',
  code: 'Code from the email',
  confirm: 'Confirm code',
  confirming: 'Checking…',
  codeMissing: 'Enter the 6-digit code from the email.',
  check: 'I opened the link: check again',
  checking: 'Checking…',
  unread: 'We could not check your address just now. Your link still works; try again in a moment.',
  stillUnverified: 'This address is still unverified. Open the newest link from the email, or send a new one.',
  'auth.email_confirm_rate_limited': 'You asked for several emails already. You can ask again in {minutes} min.',
  'auth.email_confirm_rate_limited_plain': 'You asked for several emails already. Wait a while, then ask again.',
  'auth.email_confirm_resend_too_soon': 'A confirmation email was sent a moment ago. You can ask for a new one in {seconds} s.',
  'auth.email_confirm_resend_too_soon_plain': 'A confirmation email was sent a moment ago. Wait a moment, then ask again.',
  'auth.email_confirm_code_invalid': 'That code is not right. Check the newest email and try again.',
  'auth.email_confirm_code_locked': 'Too many wrong codes, so that code no longer works. Send a new one.',
  'auth.email_confirm_expired': 'That code has run out. Send a new one.',
  'auth.email_confirm_used': 'That code was already used. Send a new one if your address still shows as unverified.',
  'vendor.email': 'Email delivery is switched off in this build, so a confirmation code cannot be sent. Your address stays unverified.',
  'auth.email_confirm_unwired':
    'Email confirmation is not set up in this build: its owner settings are not published, so no code can be sent. Your address stays unverified.',
} as const;

export const verifyEmailCopy = defineCopy('account.verify-email', messages);
