import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Sign in with a code instead',
  intro: 'We email a 6-digit code to the address on your account. No password needed.',
  identifier: 'Email or handle for the code',
  send: 'Email me a code',
  sending: 'Sending…',
  checkEmail: 'Check your email',
  checkEmailBody:
    'If {name} has an account, a 6-digit code is on its way to its email. It can take a few minutes to arrive. Only the newest code works.',
  code: 'Sign-in code from the email',
  totp: 'Authenticator or recovery code',
  totpHint: 'This account also asks for its second step.',
  signIn: 'Sign in with the code',
  checking: 'Checking…',
  resend: 'Send a new code',
  resendIn: 'You can ask for a new code in {seconds} s.',
  resent: 'A new code is on its way. Only the newest code works.',
  differentName: 'Use a different email or handle',
  codeMissing: 'Enter the 6-digit code from the email.',
  'auth.codes_unwired': 'Sign-in by code is switched off: its settings are not published. Use your password.',
  'auth.code_invalid': 'That code is not right, or it was already used. Check the newest email, or ask for a new code.',
  'auth.code_expired': 'This code has run out. Ask for a new one.',
  'auth.too_many_attempts': 'Too many tries. Try again in {minutes} min.',
  'auth.mfa_required': 'The code is right. This account also needs its authenticator code: enter it and sign in again.',
  'auth.mfa_invalid': 'That authenticator code did not work, or it was already used. Wait for the next one.',
  'auth.account_frozen':
    'This account is frozen. Sign-in and money actions are paused. Only support can lift a freeze, so contact them to ask why.',
  closed: 'This account is closed. A closed account cannot be reopened. Contact support if you have a question about it.',
  stateHelp: 'Contact support',
  'identity.resend_too_soon': 'A code was sent a moment ago. Wait a little, then ask again.',
  'vendor.email': 'Email delivery is switched off in this build, so a sign-in code cannot be sent. Use your password.',
  'vendor.sms': 'Codes by text message need a provider that is switched off in this build. Use your email or handle.',
} as const;

export const codeSignInCopy = defineCopy('public-code-sign-in', messages);
