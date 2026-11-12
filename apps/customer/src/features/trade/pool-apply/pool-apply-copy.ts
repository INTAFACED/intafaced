import { defineCopy } from '../../../shared/i18n';

// The master center: apply to run a pooled strategy (CB-copy-pro-share-11). English source; other languages fall back
// to English. No service sentence is shown.
const en = {
  title: 'Master center',
  description: 'Apply to run a pooled strategy that followers join. Founders see applications oldest first.',
  nicknameLabel: 'Nickname',
  nicknameHint: 'The name followers see. 1 to 80 characters.',
  styleLabel: 'Trading style',
  styleHint: 'How you trade, in a sentence. 1 to 280 characters.',
  apply: 'Apply to run a pool',
  sent: 'Application sent. Founders see it in their queue.',
  applied: 'You applied as {name}.',
  summaryTitle: 'What happens next',
  summaryPools:
    'A pool holds its followers’ money in one place. INTAFACED holds no customer money, so no pool can open and no application can be approved.',
  summaryOnce: 'One application per account. Sending the same one again changes nothing.',
  signedOutTitle: 'Sign in to apply',
  signedOutBody: 'An application belongs to your account.',
  signIn: 'Sign in',
  readFailedTitle: 'Your application could not be read',
  readFailedBody: 'Nothing was sent. Try again in a moment.',
  tryAgain: 'Try again',
  refusedTitle: 'The application was not sent',
  openTitle: 'You have already applied',
  openBody: 'Your account already has an application to run a pool.',
  nameTitle: 'Check the nickname',
  nameBody: 'Enter a nickname of 1 to 80 characters.',
  styleTitle: 'Describe your trading style',
  styleBody: 'Enter your trading style in 1 to 280 characters.',
  uncertainBody: 'We could not confirm whether it was sent. Read this page again before you apply again.',
  otherBody: 'Nothing was sent. Try again in a moment.',
} as const;
export type PoolApplyCopyKey = keyof typeof en;
export const poolApplyCopy = defineCopy('trade.poolApply', en);
