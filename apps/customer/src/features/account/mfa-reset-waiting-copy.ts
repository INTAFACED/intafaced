import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Second step reset waiting',
  body: 'Someone used your password and a code from your email to reset your second step. Unless you stop it, your authenticator app and its recovery codes are removed after {time}, and every device is signed out.',
  asked: 'Asked {time}.',
  notYou: 'If this was not you, stop it now and change your password.',
  stop: 'Stop this reset',
  stopping: 'Stopping…',
  stopped: 'The reset was stopped. Your authenticator app stays on.',
  gone: 'This reset already ended. Nothing changed.',
  refusedDelegated: 'Sign in on this device. An API key or a sub-account cannot stop a reset.',
} as const;

export const mfaResetWaitingCopy = defineCopy('account.mfa-reset-waiting', messages);
