import { defineCopy } from '../../shared/i18n';

// The title and the unset-wait refusal come from Security's own freeze copy (account.freeze), so both screens say the same.
const messages = {
  body: 'You are signed in, and your money stays where it is.',
  stops: 'While the freeze holds, you cannot:',
  stopsNothing: 'This freeze stops nothing else on your account.',
  since: 'Frozen on {date}.',
  liftAt: 'You can reactivate it yourself from {date}, in Security, with your authenticator code or a passkey.',
  liftNow: 'The waiting time has passed. You can reactivate it now in Security, with your authenticator code or a passkey.',
  security: 'Reactivate in Security',
  continue: 'Continue',
} as const;

export const frozenByYouCopy = defineCopy('public-frozen-by-you', messages);
