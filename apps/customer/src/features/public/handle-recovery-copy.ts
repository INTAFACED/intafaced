import { defineCopy } from '../../shared/i18n';

const messages = {
  open: 'I forgot my handle',
  title: 'Get your handle by email',
  body: 'Enter the email address on your account. If an account uses it, we email you its handle.',
  emailField: 'Email address for your handle',
  send: 'Email me my handle',
  sending: 'Sending…',
  sent: 'If an account uses this email, its handle is on its way. It can take a few minutes to arrive.',
  invalidEmail: 'Enter the email address on your account.',
  off: 'Handle recovery is switched off: its settings are not published. Nothing was sent. Contact Support and a person will help you.',
} as const;

export const handleRecoveryCopy = defineCopy('public-handle-recovery', messages);
