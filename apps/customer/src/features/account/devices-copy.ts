import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Your devices',
  body: 'Each row is a device you are signed in on. Signing a device out ends its sign-in; it has to sign in again.',
  thisDevice: 'This device',
  unknownDevice: 'Unknown device',
  lastActive: 'Last active {time}',
  signedIn: 'Signed in {time}',
  country: 'Country {country}',
  signOut: 'Sign out',
  signOutLabel: 'Sign out {device}',
  signOutOthers: 'Sign out all other devices',
  confirmOthers: 'Sign out every other device now? This device stays signed in.',
  confirm: 'Yes, sign out',
  cancel: 'Cancel',
  working: 'Working…',
  empty: 'No devices are signed in',
  endedOne: 'Device signed out.',
  endedNone: 'That device was already signed out.',
  endedOthers: 'Signed out {count} other devices.',
  endedNoOthers: 'No other devices were signed in.',
  refresh: 'Refresh',
  window: 'Showing up to {limit} devices.',
} as const;

export const devicesCopy = defineCopy('account.devices', messages);
