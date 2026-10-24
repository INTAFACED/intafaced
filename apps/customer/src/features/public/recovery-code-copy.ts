import { defineCopy } from '../../shared/i18n';

const messages = {
  useCode: 'Use a recovery code',
  useApp: 'Use the authenticator app instead',
  field: 'Recovery code',
  fieldHint: 'Each recovery code works once. Enter your password again with one of the codes you saved.',
  title: 'Signed in with a recovery code',
  spent: 'That recovery code is now spent and will not work again.',
  left: 'Recovery codes left: {count}',
  none: 'You have no recovery codes left. Open Security to replace your authenticator app before you need a code again.',
  continue: 'Continue',
  security: 'Open Security',
} as const;

export const recoveryCodeCopy = defineCopy('public-recovery-code', messages);
