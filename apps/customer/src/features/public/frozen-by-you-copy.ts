import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'You froze this account',
  body: 'You are signed in, and your money stays where it is. While the freeze holds, no API key can be created.',
  since: 'Frozen on {date}.',
  liftAt: 'You can reactivate it yourself from {date}, in Security, with your authenticator code or a passkey.',
  liftNow: 'The waiting time has passed. You can reactivate it now in Security, with your authenticator code or a passkey.',
  liftUnset: 'No waiting time is set for lifting a freeze, so reactivation is refused.',
  security: 'Reactivate in Security',
  continue: 'Continue',
} as const;

export const frozenByYouCopy = defineCopy('public-frozen-by-you', messages);
