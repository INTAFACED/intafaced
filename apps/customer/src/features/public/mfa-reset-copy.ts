import { defineCopy } from '../../shared/i18n';

const messages = {
  lost: 'I lost my authenticator',
  title: 'Reset your second step',
  intro:
    'Lost your phone and every recovery code? Enter your password again and we email a code to the address on your account. After the code, the reset waits a set time, and everyone on your account is told, so you can stop it if it was not you.',
  identifier: 'Email or handle',
  password: 'Password',
  send: 'Email me a code',
  sending: 'Sending…',
  mailed: 'We emailed a 6-digit code to {email}. It works until {time}.',
  code: 'Code from the email',
  confirm: 'Start the reset',
  confirming: 'Checking…',
  waiting: 'Your second step is being reset. It waits until {time}.',
  told: 'We told every contact on file: an email went to {email}.',
  noSms: 'Texts are not sent in this build, so your phone number was not texted.',
  notYou: 'Not you? Sign in on a device you trust and stop it from Security.',
  after:
    'After that time, sign in with your password alone. The authenticator app and its recovery codes are then removed, every device is signed out, and you can set up the app again on your new phone.',
  newCode: 'Send a new code',
  back: 'Back to sign in',
  support: 'Write to Support',
  'identity.mfa_reset_unconfigured':
    'Resetting the second step on your own is switched off: its waiting time is not set. Write to Support and a person will help you get back in.',
  'identity.mfa_reset_no_proved_address':
    'This account has no proved email address to send the code to. Write to Support and a person will help you get back in.',
  'identity.mfa_reset_not_enrolled': 'This account has no authenticator app to reset. Go back and sign in with your password.',
  'identity.security_locked':
    'The security lock is on, so the second step cannot be reset. Write to Support and a person will help you get back in.',
  'auth.invalid_credentials': 'Those details did not work. Check the email or handle and the password.',
  'auth.code_invalid': 'That code is not right. Check the newest email.',
  'auth.code_expired': 'This code has run out. Press "Send a new code".',
  'auth.too_many_attempts': 'Too many tries. Wait a few minutes, then ask for a new code.',
  'auth.codes_unwired': 'Codes by email are not available: their settings are not published. Write to Support.',
  'vendor.email': 'Email delivery is switched off in this build, so no code can be sent. Write to Support.',
} as const;

export const mfaResetCopy = defineCopy('public-mfa-reset', messages);
