import { defineCopy } from '../../../shared/i18n';

// Apply to lead (CB-copy-12). English source; other languages fall back to English. No service sentence is shown.
const en = {
  title: 'Apply to lead',
  description: 'Ask to be listed as a leader that others can copy. Founders review applications oldest first.',
  nameLabel: 'Display name',
  nameHint: 'The name followers see. 1 to 80 characters.',
  apply: 'Apply to lead',
  sent: 'Application sent. Founders review applications oldest first; their decision shows here.',
  waiting: 'Your application as {name} is waiting for review.',
  approved: 'You lead copy trading as {name}.',
  openCopy: 'Open copy trading',
  rejected: 'Your application as {name} was rejected: {reason}',
  summaryTitle: 'What happens next',
  summaryReview: 'A founder checks your application against the lead criteria, and a second founder confirms it.',
  summaryRecord: 'Your track record is not measured by the platform, so founders check it themselves.',
  signedOutTitle: 'Sign in to apply',
  signedOutBody: 'An application belongs to your account.',
  signIn: 'Sign in',
  readFailedTitle: 'Your application could not be read',
  readFailedBody: 'Nothing was sent. Try again in a moment.',
  tryAgain: 'Try again',
  refusedTitle: 'The application was not sent',
  openTitle: 'An application is already waiting',
  openBody: 'You already applied under another name. Wait for the founders’ decision on it.',
  leadingTitle: 'You already lead',
  leadingBody: 'Your account is already listed as a leader.',
  nameTitle: 'Check the display name',
  nameBody: 'Enter a display name of 1 to 80 characters.',
  waitTitle: 'Applying again is closed',
  waitBody: 'Applying again waits on a waiting period the platform has not set.',
  uncertainBody: 'We could not confirm whether it was sent. Read this page again before you apply again.',
  otherBody: 'Nothing was sent. Try again in a moment.',
} as const;
export type LeadApplyCopyKey = keyof typeof en;
export const leadApplyCopy = defineCopy('trade.leadApply', en);
