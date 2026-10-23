import { defineCopy } from '../../shared/i18n';

const messages = {
  close: 'Close help',
  title: 'When codes do not work',
  why: 'Codes depend on the clock. Each code lasts 30 seconds, so a clock that is off by more than a few seconds can give codes we cannot accept.',
  checking: 'Comparing this device’s clock with ours…',
  ahead:
    'This device’s clock is {seconds} seconds ahead of ours. Set this device and your phone to set the time automatically, then try a new code.',
  behind:
    'This device’s clock is {seconds} seconds behind ours. Set this device and your phone to set the time automatically, then try a new code.',
  inSync:
    'This device’s clock is within {limit} seconds of ours, so codes should work. If your phone shows the same time and codes still fail, the entry in your app may be an old one: replace it.',
  checkFailed: 'We could not read our clock, so we cannot say whether yours is off.',
  checkAgain: 'Check again',
  syncTitle: 'Apps that sync codes',
  sync: 'If your authenticator app copies codes to a cloud account, anyone who gets into that account gets your codes too. Protect that account with its own second step, or use an app that keeps codes on the phone.',
  moveTitle: 'Moving to a new phone',
  move1: 'Keep the old phone until you finish.',
  move2: 'Press Replace and confirm with a code from the old phone.',
  move3: 'Add the setup key to the app on the new phone and enter the code it shows, then the next code from the old one.',
  move4: 'Delete the old entry from the old phone.',
  moveStart: 'Move to a new phone',
  replace: 'Replace',
} as const;

export const codesHelpCopy = defineCopy('account.codes-help', messages);
