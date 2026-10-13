import { defineCopy } from '../../shared/i18n';

// English source only (UI-SPEC 4.4). Plain words: no internal terms, none of the banned words.
const messages = {
  Settings: 'Settings',
  'Settings sections': 'Settings sections',
  Account: 'Account',
  Security: 'Security',
  Verification: 'Verification',
  Display: 'Display',
  'Account ID': 'Account ID',
  'Copy account ID': 'Copy account ID',
  Copy: 'Copy',
  Copied: 'Copied',
  'Copy failed': 'Couldn’t copy. Select the ID and copy it yourself.',
  'Account ID help': 'Quote this ID if you contact support.',
} as const;

export const accountScreenCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.account-screen', messages);
