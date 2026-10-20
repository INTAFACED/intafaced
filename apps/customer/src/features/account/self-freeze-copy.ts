import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Freeze your account',
  body: 'Use this if you think someone else has access, or you want to stop everything for a while. Freezing signs out every device and revokes every API key right away. Your money stays where it is and is not touched.',
  consequences: 'While frozen, no API key can be created. Lifting the freeze is a separate step.',
  reasonLabel: 'Why are you freezing it?',
  reasonCompromise: 'Someone else may have access',
  reasonTemporary: 'I want to pause for a while',
  reasonPersonal: 'Another reason',
  passwordField: 'Your password',
  passwordNeeded: 'Enter your password to confirm.',
  freezeAsk: 'Freeze my account',
  working: 'Working…',
  frozenTitle: 'You froze this account',
  frozenBody: 'Frozen on {date} ({reason}). Every device and API key was signed out.',
  frozenNote: 'Your account is frozen. You will be signed out.',
  refusedPassword: 'That password is not right.',
  refusedDelegated: 'Sign in on this device. An API key or a sub-account cannot freeze this account.',
  refusedClosed: 'This account is closed and cannot be frozen.',
} as const;

export const selfFreezeCopy = defineCopy('account.freeze', messages);
export type FreezeCopyKey = keyof typeof messages;
