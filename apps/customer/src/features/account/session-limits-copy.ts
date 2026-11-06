import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Idle sign-out',
  ownerLimit: 'A sign-in not used for {minutes} minutes ends by itself. That is the longest allowed.',
  ownerUnset:
    'No idle sign-out limit is set, so a shorter one cannot be chosen here yet. Each sign-in still ends when its own time runs out.',
  chosen: 'You chose {minutes} minutes: your sign-ins end after that long unused.',
  notChosen: 'You have not chosen a shorter time, so the limit above applies.',
  field: 'Sign me out after this many minutes unused',
  save: 'Save',
  clear: 'Use the longest allowed',
  saved: 'Saved. Your sign-ins now end after {minutes} minutes unused.',
  cleared: 'Cleared. The longest allowed applies again.',
  invalid: 'Enter a whole number of minutes.',
  devices: 'Up to {count} devices can be signed in at once. Signing in on one more ends the one signed in longest ago.',
  devicesUnset: 'No limit on signed-in devices is set.',
  'identity.session_setting_out_of_range':
    'Choose from 1 minute up to {minutes} minutes. A longer time than the limit is not allowed. Nothing was changed.',
  'identity.session_idle_unset': 'No idle sign-out limit is set, so a shorter one cannot be chosen yet. Nothing was changed.',
} as const;

export const sessionLimitsCopy = defineCopy('account-session-limits', messages);
