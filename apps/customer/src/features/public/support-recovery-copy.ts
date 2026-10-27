import { defineCopy } from '../../shared/i18n';

const messages = {
  link: 'I cannot sign in',
  eyebrow: 'ACCOUNT RECOVERY',
  title: 'Locked out? A person answers',
  intro:
    'If you lost your authenticator app and your recovery codes, and the reset on the sign-in page cannot help, Support can recover your account.',
  stepsHeading: 'How it works',
  stepCase: 'Write to Support from the email address on your account. A member of Support opens a recovery case for it.',
  stepApprove: 'A second member of Support must approve the case. One person alone can never recover an account.',
  stepLink:
    'A one-time recovery link is then sent to the email address proved on your account. Nobody at Support ever sees the link, and it works once.',
  stepAfter:
    'The link removes your authenticator app and recovery codes and signs you out everywhere. You then sign in with your password and set up a new authenticator app.',
  never: 'Support never asks for your password, a code or the link itself.',
  tryReset: 'Still know your password? Try the reset on the sign-in page first:',
  toSignIn: 'Back to sign in',
  recoverTitle: 'Recover your account',
  recoverIntro:
    'Press Recover to use the link Support sent. This removes your authenticator app and recovery codes and signs you out everywhere. The link works once.',
  recover: 'Recover',
  recovering: 'Recovering…',
  doneTitle: 'Your account is recovered',
  doneBody:
    'Your authenticator app and recovery codes were removed and every session ended. Sign in with your password, then set up a new authenticator app in Security.',
  signIn: 'Sign in',
  deadTitle: 'This recovery link does not work',
  deadBody: 'A recovery link works once and runs out after a while, and a closed case stops it. Write to Support again for a new one.',
  locked: 'Your account’s security lock holds, so it cannot be recovered until the lock ends.',
  unwired: 'Account recovery links are switched off in this build, so this link cannot be checked.',
} as const;

export const supportRecoveryCopy = defineCopy('public-support-recovery', messages);
