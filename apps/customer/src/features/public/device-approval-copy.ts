import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Authorise this device',
  intro: 'Your password was right, but this browser has not been used to sign in to this account before.',
  mailed:
    'We emailed a 6-digit code to the address on your account. Enter it here, or approve this sign-in from a device where you are already signed in.',
  unmailed:
    'Email delivery is switched off in this build, so no code was sent. Approve this sign-in from a device where you are already signed in: Account, Security, Trusted devices.',
  fromOther: 'Approved it on your other device? This page signs you in by itself within a few seconds, or press Continue.',
  code: 'Device code from the email',
  approve: 'Approve this device',
  checking: 'Checking…',
  continue: 'Continue',
  cancel: 'Start over',
  expires: 'This request runs out at {time}.',
  codeMissing: 'Enter the 6-digit code from the email.',
  'auth.code_invalid': 'That code is not right. Check the newest email.',
  'auth.code_expired': 'This request has run out. Start over and sign in again.',
  'auth.too_many_attempts': 'Too many wrong codes. Start over and sign in again for a new code.',
  'auth.device_authorisation_invalid': 'This request is no longer valid. Start over and sign in again.',
  'auth.device_authorisation_used': 'This request was already used. Start over and sign in again.',
  'auth.device_authorisation_pending': 'Waiting for approval. Approve it on your other device, or enter the emailed code.',
} as const;

export const deviceApprovalCopy = defineCopy('public-device-approval', messages);
