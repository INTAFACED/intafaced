import { defineCopy } from '../../../shared/i18n';

// The daily loss limit (J-derivatives-35): the Risk rules room, the desk's line and the review's confirm. Figures, assets
// and times enter through parameters; nothing here is a number or a sample.
const en = {
  title: 'Risk rules',
  lead: 'Rules you set for your own venue account. Each one is off until you turn it on.',
  explain:
    'A rule that makes trading stricter applies at once. One that loosens it (a higher limit, warning instead of stopping, turning it off) waits 24 hours, so a bad day cannot talk you out of it. Closing a position, moving a stop or target and cancelling an order are never held.',
  signedOutTitle: 'Sign in to set your risk rules',
  signedOutBody: 'Risk rules belong to your account.',
  signIn: 'Sign in',
  checking: 'Checking the venue',
  noVenueTitle: 'Risk rules count your own venue account',
  noVenueBody: 'No venue is connected for your account, so there is no account to count a daily loss on.',
  unread:
    'Your daily loss limit could not be read just now, so whether it is on is not known here. Every order is still checked against it.',
  connect: 'Connect your wallet to see and set your daily loss limit.',

  heading: 'Daily loss limit',
  intro: 'Counts the loss you realise today on your venue account, as the venue reports it, less fees. Open positions are not counted.',
  off: 'Off',
  onAdvisory: 'On: warn me once today’s loss reaches {limit} {asset}',
  onBlocking: 'On: stop new trades once today’s loss reaches {limit} {asset}',
  turnOn: 'Turn on',
  turnOff: 'Turn off',
  modeLabel: 'When the limit is reached',
  warnMe: 'Warn me',
  stopNew: 'Stop new trades',
  warnMeHint: 'New opening orders still go, after you confirm.',
  stopNewHint: 'New opening orders are refused until the day resets. Closing orders still go.',
  limitLabel: 'Limit ({asset})',
  save: 'Save',
  saving: 'Saving',
  cancel: 'Cancel',
  resets: 'The day resets at 00:00 UTC: next at {time}.',
  today: 'Today’s realised loss from {venue}: {loss} {asset} of your {limit} {asset} limit.',
  todayOff: 'Today’s realised loss from {venue}: {loss} {asset}.',
  todayAsOf: 'As of {time}.',
  todayUnread: 'Today’s loss could not be read from {venue} just now. It is not counted as no loss.',
  reached: 'Reached: today’s loss of {loss} {asset} has reached your limit of {limit} {asset}.',
  pendingHeading: 'Waiting 24 hours',
  pendingTerms: 'Asked: {terms}. Takes effect at {time}.',
  pendingOff: 'Asked: turn the limit off. Takes effect at {time}.',
  pendingUntil: 'Until then {terms} still holds.',
  termsAdvisory: 'warn me at {limit} {asset}',
  termsBlocking: 'stop new trades at {limit} {asset}',
  savedNow: 'Saved. It applies now.',
  savedWaits: 'Saved. It loosens your limit, so it waits 24 hours, until {time}.',
  saveFailed: 'Not saved: {detail}',
  limitInvalid: 'Write the limit as a number above zero, like 100 or 250.5.',
  openRules: 'Risk rules',

  deskAdvisory:
    'Daily loss limit reached: you have lost {loss} {asset} today, reaching your limit of {limit} {asset}. New opening orders ask you to confirm first.',
  deskBlocking:
    'Daily loss limit reached: you have lost {loss} {asset} today, reaching your limit of {limit} {asset}. New opening orders are stopped until the day resets at {time}. Closing, stops and cancels still go.',
  deskUnread:
    'Your daily loss limit of {limit} {asset} is on, and today’s loss could not be read from {venue} just now. It is not counted as no loss.',
  confirmHeading: 'You have reached your daily loss limit',
  confirmBody: 'Today’s loss of {loss} {asset} has reached your daily loss limit of {limit} {asset}.',
  confirmUnread: 'Today’s loss could not be read just now, so your daily loss limit of {limit} {asset} cannot be checked.',
  confirmAccept: 'Open it anyway, past my daily loss limit of {limit} {asset}',
  refusedHeading: 'Stopped by your daily loss limit',
  refusedBody:
    'Today’s loss of {loss} {asset} has reached your daily loss limit of {limit} {asset}, so this opening order was refused. Nothing was sent. The day resets at {time}.',
} as const;
export type DailyLossCopyKey = keyof typeof en;
export const dailyLossCopy = defineCopy('trade.dailyLoss', en);
