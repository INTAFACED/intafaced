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
  expiredTitle: 'This link has expired',
  expiredBody: 'A confirmation link runs out after a while, and this one has. Sign in, open Account and send a new one.',
  usedTitle: 'This link was already used',
  usedBody:
    'A confirmation link works once, and this one was used already. If your address shows as verified on Account, there is nothing more to do; if not, sign in, open Account and send a new one.',
  unwired: 'Email confirmation is switched off in this build, so this link cannot be checked.',
} as const;

export const confirmEmailCopy = defineCopy('public-confirm-email', messages);
