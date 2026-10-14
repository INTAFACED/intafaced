import { defineCopy } from '../shared/i18n';

// English source only (UI-SPEC 4.4). Plain words. The caption and the sheet title are fixed wording; do not reword them per screen.
export const previewCopy = defineCopy('customer.preview', {
  Preview: 'Preview',
  'Preview caption': 'Preview: sample numbers, not your account',
  'Sheet title': 'Preview: nothing was sent',
  'Sheet body': '{product} is not live yet. Nothing was sent, and nothing on your account changed.',
  OK: 'OK',
  'Screen being built': 'This screen is being built. It will show sample data for {product}, clearly marked.',
  'Try an action': 'Try an action',
  'Sample data heading': 'Sample data',
  Value: 'Value',
  Detail: 'Detail',
  Item: 'Item',
} as const);
