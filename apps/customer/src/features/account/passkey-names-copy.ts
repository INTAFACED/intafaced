import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Passkey names and types',
  body: 'Name each passkey so you can tell them apart. Renaming asks you to confirm it is you.',
  unnamed: 'Unnamed passkey',
  platform: 'This device',
  cross_device: 'Phone or other device',
  security_key: 'Security key',
  unknown: 'Type not reported',
  added: 'Added {time}',
  lastUsed: 'Last used {time}',
  neverUsed: 'Never used',
  limit: 'Up to {count} passkeys on this account.',
  noLimit: 'No passkey limit is set.',
  empty: 'No passkeys yet',
  rename: 'Rename',
  renameLabel: 'Rename passkey {id}',
  nameField: 'Name (1 to 64 characters)',
  codeField: '6-digit code from your authenticator app',
  save: 'Save with code',
  savePasskey: 'Save with a passkey',
  cancel: 'Cancel',
  working: 'Working…',
  saved: 'Name saved.',
  invalidName: 'Use 1 to 64 characters, with no control characters.',
  invalidCode: 'Enter the 6-digit code, or confirm with a passkey.',
  refresh: 'Refresh',
} as const;

export const passkeyNamesCopy = defineCopy('account.passkey-names', messages);
