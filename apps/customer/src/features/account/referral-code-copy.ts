import { defineCopy } from '../../shared/i18n';

export const referralCodeCopy = defineCopy('account.referralCode', {
  title: 'Your referral code',
  label: 'Referral code · share it with the people you invite',
  copy: 'Copy code',
  copied: 'Referral code copied.',
  copyUnavailable: 'Copy is unavailable. Select the code above.',
  meaning: 'One code per account. It never changes and it is not a password. Your invitation link works on its own.',
  none: 'No referral code yet',
  noneBody: 'Get your code once. Pressing again returns the same code.',
  create: 'Get my referral code',
  lengthUnset: 'No referral code can be made: the owner has not set how long a code is. Your invitation link still works.',
  refused: 'The service refused to make a code. Nothing was created.',
});
