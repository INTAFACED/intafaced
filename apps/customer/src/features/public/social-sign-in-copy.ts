import { defineCopy } from '../../shared/i18n';

const messages = {
  or: 'Or',
  social: 'Continue with a social account',
  wallet: 'Continue with a wallet',
  starting: 'Opening…',
  'idp.social':
    'Social and wallet sign-in need an outside sign-in provider, which is switched off in this build. Use your email instead; nothing was created.',
  'identity.social_provider_config_incomplete':
    'This sign-in provider is only partly set up, so it is switched off. Use your email instead; nothing was created.',
  'identity.social_flow_ttl_unset':
    'Social sign-in is switched off: its time limit is not published. Use your email instead; nothing was created.',
} as const;

export const socialSignInCopy = defineCopy('public-social-sign-in', messages);
