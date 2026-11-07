import { defineCopy } from '../../shared/i18n';

// English source only (UI-SPEC §4.4); other languages fall back to English. Curly quotes on purpose.
// Chart templates on the workbench (C-embed-feed-ops-03, J-charts-desk-07 #6). Each refusal says the real reason in one
// sentence; the service code is never shown.
const messages = {
  Templates: 'Templates',
  'Chart templates': 'Chart templates',
  'Templates loading': 'Loading your templates…',
  'Templates failed': 'Couldn’t load your templates.',
  'Try again': 'Try again',
  'Templates signed out': 'Sign in to keep chart templates on every device.',
  'No templates': 'No templates kept by this account. Save this chart’s studies to use them on any chart.',
  'Save as template': 'Save as template',
  'Template name': 'Template name',
  'Save template': 'Save template',
  'Saved template': 'Template “{name}” saved.',
  Cancel: 'Cancel',
  'Replace title': 'Replace “{name}”?',
  'Replace body': 'A template called “{name}” is kept already. Replace it with this chart’s studies?',
  Replace: 'Replace',
  'Template facts': 'Studies: {count}',
  'What it keeps': 'A template keeps the studies and the chart style. Drawings stay on the chart they were drawn on.',
  'Name needed': 'Give the template a name.',
  'Name too long': 'A template name is 40 characters at most.',
  'Not drawable': 'This template holds a study this chart can’t draw, so nothing was changed.',
  Applied: 'Template “{name}” applied. Studies: {count}.',
  'identity.preferences_value_invalid': 'That template couldn’t be kept: the account allows 50 templates of up to 25 studies each.',
  'reply.unknown': 'We couldn’t tell whether that was kept. Your templates were read again; check the list.',
  'Write failed': 'Couldn’t change your templates. Try again.',
} as const;

export const templatesCopy = defineCopy('charts.templates', messages);

const REFUSALS = ['identity.preferences_value_invalid', 'reply.unknown'] as const;
type RefusalKey = (typeof REFUSALS)[number] | 'Write failed';

export function templateRefusal(code: string): RefusalKey {
  return (REFUSALS as readonly string[]).includes(code) ? (code as RefusalKey) : 'Write failed';
}
