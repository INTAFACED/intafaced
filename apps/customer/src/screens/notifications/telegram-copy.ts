import { defineCopy } from '../../shared/i18n';

// English source only. The read-only Telegram desk alerts on the preferences page (J-charts-desk-21).
export const telegramCopy = defineCopy('notifications-telegram', {
  title: 'Telegram',
  intro: 'Your fills and margin warnings, and /positions and /pnl answers, in a private Telegram chat. You cannot trade from the chat.',
  offToken: 'Telegram is not set up on this platform, so it cannot be linked.',
  offOutOfApp: 'Messages outside the app are switched off on this platform, so Telegram cannot be linked.',
  unlinked: 'Not linked.',
  linked: 'Linked to {handle} since {when}.',
  linkedNoHandle: 'Linked since {when}.',
  testTag: 'TEST',
  testBot: 'TEST bot: messages go to this test platform’s TEST chat, not to Telegram.',
  connect: 'Connect Telegram',
  newCode: 'Get a new code',
  sendThis: 'Send this message to {bot} in Telegram:',
  sendThisNoBot: 'Send this message to the INTAFACED bot in Telegram:',
  validFor: 'Valid for 5 minutes, until {when}. It works once.',
  waiting: 'Once you send it, this page shows Telegram linked.',
  unlink: 'Unlink',
  unlinkedDone: 'Telegram unlinked. Nothing more is sent to that chat.',
  failed: 'That did not go through. Try again.',
  loadFailed: 'Could not load your Telegram link.',
  tryAgain: 'Try again',
});
