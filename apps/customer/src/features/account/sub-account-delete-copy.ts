import { defineCopy } from '../../shared/i18n';

const messages = {
  open: 'Delete…',
  title: 'Delete this sub-account',
  body: 'Deleting retires this sub-account for good. It never moves or removes money: it is only possible once the sub-account holds no assets and has no open orders or positions.',
  checking: 'Checking what is still open…',
  allClear: 'Nothing is open on this sub-account. You can delete it.',
  stillOpen: 'These need to be cleared first:',
  balancesTitle: 'Balances this sub-account still holds',
  blockBalance: 'Balances still held in {count} places',
  blockOrder: 'Open orders: {count}',
  blockPosition: 'Open positions: {count}',
  blockOther: 'Something else is still open ({count})',
  confirmTitle: 'Confirm it is you',
  confirmBody: 'Enter the 6-digit code from your authenticator app.',
  codeField: '6-digit code',
  invalidCode: 'Enter the 6 digits from your app.',
  delete: 'Delete sub-account',
  recheck: 'Check again',
  cancel: 'Close',
  working: 'Working…',
  done: 'Sub-account deleted.',
  refusedBlocked: 'Something is still open on this sub-account. Clear it, then check again.',
  refusedCheck: 'We could not confirm that this sub-account is empty. Try again later.',
  refusedNotFound: 'That sub-account was not found.',
  refusedDelegated: 'Sign in on this device. An API key or a sub-account cannot delete a sub-account.',
} as const;

export const subAccountDeleteCopy = defineCopy('account.subaccountDelete', messages);
