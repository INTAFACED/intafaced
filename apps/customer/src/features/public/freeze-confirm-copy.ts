import { defineCopy } from '../../shared/i18n';

const messages = {
  eyebrow: 'ACCOUNT SECURITY',
  title: 'Freeze your account',
  intro:
    'You opened the link from a security notice about your account. If you did not make that change, freeze your account now. This signs you out everywhere and stops every API key, and withdrawals and new sign-in changes stay blocked until you lift the freeze.',
  freeze: 'Freeze my account',
  freezing: 'Freezing…',
  doneTitle: 'Your account is frozen',
  doneBody: 'Every session and API key was ended. Sign in to see the freeze and lift it once you are safe again. Frozen since',
  usedTitle: 'This link was already used',
  usedBody: 'Nothing changed now. When it was first used, this link froze your account. Frozen since',
  liftedNow:
    'That freeze has been lifted since, so your account is not frozen now. If a change was not yours, sign in and freeze it again from Security.',
  signIn: 'Sign in',
  deadTitle: 'This freeze link does not work',
  deadBody: 'Sign in and freeze your account from Security, or write to Support if you cannot sign in.',
  help: 'I cannot sign in',
} as const;

export const freezeConfirmCopy = defineCopy('public-freeze-confirm', messages);
