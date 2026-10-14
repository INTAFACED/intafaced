import { defineCopy } from '../../shared/i18n';

// The notes for an action whose result isn't known yet, and for what a security action did. English source only (UI-SPEC 4.4),
// plain words. They replace the older account.security and account.sessions catalogs, whose wording was still technical.
const security = {
  blockedSessions:
    'Signing out everywhere isn’t confirmed. Signing out single sessions is on hold, and the list below is for checking only.',
  inspectSessions: 'Refresh the list',
  setupReady: 'Authenticator setup is ready. It still needs your code.',
  hideKey: 'Hide setup key',
  showKey: 'Show setup key',
  setupKey: 'Setup key',
  uri: 'Setup link',
  memory: 'Your setup key and recovery codes are shown once. Save them before you leave this page.',
  newSetup: 'Start again',
  replacement: 'Starting again replaces any setup you haven’t finished.',
  sent: 'Sending…',
  guardRetained: 'One last step',
  preparationUnknown: 'We didn’t hear back',
  unknown: 'We couldn’t confirm this',
  options: 'Passkey step',
  register: 'Adding a passkey',
  removeKind: 'Removing a passkey',
  setup: 'Authenticator setup',
  confirmKind: 'Authenticator code',
  logoutKind: 'Signing out everywhere',
  guardBody:
    'We have our answer, but a note about it is still saved on this device. Contact support before you make another change of this kind.',
  optionsBoundary: 'We asked your browser to start adding a passkey, but nothing was added to your account. You can try again.',
  setupBoundary: 'Setup was started, but nothing was confirmed. You can start again. The earlier attempt stays unconfirmed.',
  unknownBody: 'It may or may not have gone through. Don’t repeat it yet. Contact support and quote the reference below.',
  lookup: 'These details stay here until it’s sorted out.',
  support: 'Contact support',
  storage: 'We couldn’t safely save a note about this on your device, so nothing was sent. Try again, or contact support.',
  changed: 'Your account or session changed while you were checking this. Nothing was sent. Start again.',
  keyChanged: 'That passkey has changed or isn’t on the list any more. Nothing was removed. Refresh and try again.',
  setupChanged: 'A newer setup replaced this one, so its key is hidden. Start setup again to continue.',
  another: 'Another tab is already making a security change for this account. Nothing was sent here.',
  locks: 'This browser can’t do this safely. Nothing was sent. Try Chrome, Safari or Firefox.',
  unsupported: 'Passkeys need a supported browser and a secure connection. Nothing was sent.',
  cancelled: 'The passkey step was stopped. Nothing was added.',
  ceremonyFailed:
    'Your browser couldn’t finish the passkey step. Nothing was added to your account. A passkey may have been saved on your device only.',
  registered: 'Passkey added.',
  removed: 'Passkey removed.',
  notRemoved: 'No passkey was removed. It may already be gone.',
  confirmationAccepted: 'Your authenticator is on.',
} as const;

const sessions = {
  sending: 'Signing out that session…',
  guardRetained: 'One last step',
  unknown: 'We couldn’t confirm that sign-out',
  guardBody: 'We have our answer, but a note about it is still saved on this device. Further sign-outs stay on hold. Contact support.',
  unknownBody: 'It may or may not have gone through. Don’t repeat it yet. Contact support and quote the reference below.',
  lookup: 'Other sign-outs are on hold until this is sorted out.',
  support: 'Contact support',
  storage: 'We couldn’t safely save a note about this on your device, so nothing was sent. Try again, or contact support.',
  changed: 'Your account changed while you were checking this. Nothing was sent. Review it again.',
  seatChanged: 'That session changed or isn’t listed any more. Nothing was sent. Refresh and try again.',
  another: 'Another tab is signing a session out for this account. Nothing was sent here.',
  locks: 'This browser can’t do this safely. Nothing was sent. Try Chrome, Safari or Firefox.',
  revoked: 'That session was signed out.',
  unchanged: 'Nothing was signed out. It may already have ended. Refresh the list.',
} as const;

export const securityNotesCopy: ReturnType<typeof defineCopy<typeof security>> = defineCopy('customer.security-notes', security);
export const sessionNotesCopy: ReturnType<typeof defineCopy<typeof sessions>> = defineCopy('customer.session-notes', sessions);
