import { defineCopy } from '../../shared/i18n';

const messages = {
  eyebrow: 'EMAIL',
  title: 'Confirm your email address',
  intro: 'Press Confirm to prove this address is yours. The link works once.',
  confirm: 'Confirm',
  confirming: 'Confirming…',
  doneTitle: 'Your email address is verified',
  doneBody: 'You can close this page, or go back to your account.',
  toAccount: 'Go to Account',
  deadTitle: 'This link no longer works',
  deadBody:
    'A confirmation link works once and runs out after a while, so this one has expired or was already used. Sign in, open Account and send a new one.',
  unwired: 'Email confirmation is switched off in this build, so this link cannot be checked.',
} as const;

export const confirmEmailCopy = defineCopy('public-confirm-email', messages);
