import { defineCopy } from '../../shared/i18n';

// English source only. The reason is stated once, at the top, and again next to each switched-off button.
export const recoveryCopy = defineCopy('public-password-recovery', {
  title: 'Get back into your account',
  intro: 'Resetting a forgotten password takes three steps. This page shows all three so you know what to expect.',
  blockedTitle: 'Password reset is not switched on yet',
  blockedBody:
    'The sign-in service cannot yet send a reset code or accept a new password for someone who is locked out. Nothing you see on this page is sent anywhere, and every button below is switched off for that reason.',
  whatNow: 'What you can do now',
  whatNowBody: 'Write to us and a person will help you back in. Details are below the steps.',
  stepsLabel: 'Reset steps',
  step1: 'Ask for a reset code',
  step1Body: 'Enter the email or handle on your account. We send a six-digit code to the email address on file.',
  step2: 'Enter the code',
  step2Body: 'Type the six digits from the email. The code works once and runs out after a short time.',
  step3: 'Choose a new password',
  step3Body: 'Pick a new password you do not use anywhere else, then sign in with it.',
  accountField: 'Email or handle',
  codeField: 'Six-digit code',
  newPasswordField: 'New password',
  confirmField: 'Repeat the new password',
  passwordHint: 'At least 12 characters.',
  sendCode: 'Send reset code',
  checkCode: 'Check code',
  saveNewPassword: 'Save new password',
  offReason: 'Switched off: the sign-in service cannot do this yet.',
  stepNumber: 'Step {number}',
  backToSignIn: 'Back to sign in',
  help: 'Help centre',
  contactHeading: 'Need a person now?',
});
