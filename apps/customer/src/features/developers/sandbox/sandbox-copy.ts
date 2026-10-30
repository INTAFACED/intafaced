import { defineCopy } from '../../../shared/i18n';

// Named developer sandboxes and their keys (/developers/sandbox, DV-sandbox-01). Names, counts and addresses enter
// through parameters; nothing here is a sample or a default.
const en = {
  eyebrow: 'Developers',
  title: 'Sandbox',
  lead: 'A sandbox is a named place to try the API with TEST money. Nothing in a sandbox reaches your real balances.',
  signedOutTitle: 'Sign in to use the sandbox',
  signedOutBody: 'Sandboxes and their keys belong to your account.',
  signIn: 'Sign in',
  loading: 'Reading your sandboxes',
  readFailed: 'Your sandboxes could not be read.',

  listHeading: 'Your sandboxes',
  colName: 'Name',
  colCreated: 'Created',
  empty: 'You have no sandbox yet.',
  capSet: 'You hold {held} of the {limit} sandboxes your account may hold.',
  capUnset:
    'The owner has not set how many sandboxes an account may hold. Your first sandbox is allowed; another is refused until it is set.',
  baseUrlLabel: 'Sandbox address',
  baseUrlUnset: 'The sandbox address is not set, so a sandbox key has nowhere to be used yet.',

  formHeading: 'Create a sandbox',
  name: 'Sandbox name',
  nameHint: 'For example development, CI or UAT. Up to 40 characters.',
  submit: 'Create sandbox',
  submitting: 'Creating',
  created: 'The sandbox {name} was made.',
  replayed: 'The sandbox {name} was already made by this request.',

  refusedHeading: 'The service refused this',
  codeLabel: 'Code',
  otherRefusal: 'The service refused this request.',
  'identity.sandbox_name_invalid': 'Use a sandbox name of 1 to 40 characters.',
  'identity.sandbox_name_taken': 'You already have a sandbox with this name.',
  'identity.sandbox_cap_unset': 'The owner has not set how many sandboxes an account may hold, so no second sandbox was made.',
  'identity.sandbox_cap_reached': 'Your account holds as many sandboxes as it may, so no sandbox was made.',
  'identity.sandbox_request_conflict': 'This request was already used for another sandbox. Read the list again and retry.',
  'identity.sandbox_not_found': 'This sandbox is not on your account.',
  'env.scope_not_sandboxable':
    'This permission can’t be used in a sandbox, so no key was made. A sandbox key can read and make test payments.',
  'auth.step_up_required': 'Confirm with your passkey to make a key.',
  'auth.step_up_expired': 'The confirmation expired. Confirm again.',
  'auth.webauthn_invalid': 'The passkey could not be checked. Try again.',
  'auth.passkey_missing': 'Add a passkey to your account before you make a key.',
  'auth.scope_empty': 'Choose what the key may do.',
  'auth.scope_unknown': 'A permission on this key does not exist.',
  'auth.scope_not_held':
    'A key can’t hold a permission your sign-in does not have. Payment permissions come with an approved merchant account, so no key was made.',
  'identity.key_name_invalid': 'Use a key name of 1 to 64 characters.',
  'identity.key_name_taken': 'You already have a key with this name.',
  'identity.key_cap_unset': 'The owner has not set how many keys an account may hold, so no key was made.',
  'identity.key_cap_reached': 'Your account holds as many keys as it may, so no key was made.',
  'identity.key_request_conflict': 'This request was already used for another key. Read the page again and retry.',
  'identity.delegated_refused': 'Sign in with your own account to do this.',

  back: 'All sandboxes',
  keysHeading: 'Keys for this sandbox',
  colKey: 'Key',
  colPrefix: 'Starts with',
  colScopes: 'Permissions',
  colState: 'State',
  stateActive: 'Active',
  stateRevoked: 'Revoked',
  stateExpired: 'Expired',
  noKeys: 'This sandbox has no key yet.',
  newKey: 'Create a sandbox key',
  notFoundTitle: 'No such sandbox',
  notFoundBody: 'This sandbox is not on your account.',

  keyFormHeading: 'Create a sandbox key',
  keyFormLead: 'A sandbox key works only at the sandbox address. Its environment is fixed when it is made.',
  keyName: 'Key name',
  permissions: 'Permissions',
  presetPayments: 'Test payments',
  presetRead: 'Read only',
  presetTrade: 'Trade',
  presetPaymentsNote: 'Read and make TEST payments in this sandbox.',
  presetReadNote: 'Read TEST payments and the TEST balance in this sandbox.',
  presetTradeNote: 'Trade permissions. A sandbox does not serve trading.',
  submitPasskey: 'Create with a passkey',
  working: 'Working',

  shownTitle: 'Your new key',
  shownOnce: 'This is the only time the key is shown. Copy it now; it cannot be shown again.',
  copy: 'Copy key',
  copied: 'Copied',
  copyFailed: 'The key could not be copied. Select it and copy it yourself.',
  stored: 'I have stored this key somewhere safe',
  done: 'Done',
  keyReplayed: 'This request already made the key {name}. A key is shown only once, so none is shown now.',
} as const;

export const sandboxCopy = defineCopy('developers.sandbox', en);
export type SandboxCopyKey = keyof typeof en;
type RefusalKey = Extract<SandboxCopyKey, `${'identity' | 'env' | 'auth'}.${string}`>;

/** The room's sentence for a typed service code, or null when none is written (the page then shows the code). */
export function sandboxRefusalKey(code: string | undefined): RefusalKey | null {
  return code !== undefined && /^(identity|env|auth)\./.test(code) && code in en ? (code as RefusalKey) : null;
}
