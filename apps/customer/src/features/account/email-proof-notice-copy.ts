import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Confirm your email to place orders',
  body: 'New orders wait until you confirm the email on this account. You can still see prices and cancel open orders.',
  action: 'Confirm email',
} as const;

export const emailProofNoticeCopy = defineCopy('account.email-proof-notice', messages);
