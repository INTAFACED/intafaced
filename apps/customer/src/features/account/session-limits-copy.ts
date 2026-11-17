import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Idle sign-out',
  body: 'A device you leave unused is signed out. You can choose a shorter time than the platform’s, never a longer one.',
  ownerIdle: 'The platform signs a device out after {time} unused.',
  ownerIdleUnset: 'The platform has set no idle sign-out. A sign-in still ends {time} after you sign in.',
  applied: 'Your devices are signed out after {time} unused.',
  appliedNone: 'Your devices are not signed out for being unused.',
  ownSet: 'You chose {time}.',
  ownUnset: 'You have not chosen a shorter time.',
  label: 'Sign out after this many minutes unused',
  hint: 'From {min} to {max} minutes.',
  save: 'Save',
  clear: 'Use the platform’s time',
  working: 'Saving…',
  saved: 'Idle sign-out saved.',
  cleared: 'Your own idle sign-out is cleared.',
  notMinutes: 'Enter a whole number of minutes.',
  outOfRange: 'That is outside what you may choose: from {min} to {max} minutes. Nothing was changed.',
  devicesTitle: 'Signed-in devices',
  maxDevices: 'You can be signed in on up to {count} devices. Signing in on one more signs out the device you signed in on longest ago.',
  maxDevicesUnset: 'No limit on signed-in devices is set.',
  days: '{count} days',
  day: '1 day',
  hours: '{count} hours',
  hour: '1 hour',
  minutes: '{count} minutes',
  minute: '1 minute',
  seconds: '{count} seconds',
  second: '1 second',
} as const;

export const sessionLimitsCopy = defineCopy('account.session-limits', messages);
