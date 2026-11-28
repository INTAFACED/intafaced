import { defineCopy } from '../../shared/i18n';

export const verificationAttemptsCopy = defineCopy('account.verificationAttempts', {
  title: 'Attempts',
  failedTitle: 'Attempts could not be read',
  unset: 'No attempt limit is set.',
  standing:
    '{count} of {max} rejected requests in the last {window}. At {max}, a new request is refused for {lockout} after the last rejection.',
  hourOne: '1 hour',
  hoursMany: '{n} hours',
  locked: 'Too many rejected requests. Try again in {seconds} seconds.',
  lockedHelp: 'Read the reason on your last rejected request before you send a new one.',
});
