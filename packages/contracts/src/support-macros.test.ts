import { describe, expect, it } from 'vitest';
import {
  SUPPORT_MACRO_PLACEHOLDERS,
  fillSupportMacro,
  signedSupportReply,
  supportMacroPlaceholders,
  supportMacroSaveInputSchema,
  supportMacroUnknownPlaceholders,
} from './support-macros.js';
import * as root from './index.js';

const values = { 'ticket.subject': 'Card declined', 'ticket.category': 'account' } as const;

describe('support macros', () => {
  it('fills every known placeholder from the request, spaces inside the braces allowed', () => {
    expect(fillSupportMacro('About "{{ticket.subject}}" ({{ ticket.category }}): {{ticket.subject}}', values)).toBe(
      'About "Card declined" (account): Card declined',
    );
  });

  it('names the placeholders a body uses and the ones no request can fill', () => {
    expect(supportMacroPlaceholders('{{ticket.subject}} {{customer.name}} {{ticket.subject}}')).toEqual([
      'ticket.subject',
      'customer.name',
    ]);
    expect(supportMacroUnknownPlaceholders('{{ticket.subject}} {{customer.name}}')).toEqual(['customer.name']);
    expect(supportMacroUnknownPlaceholders('Plain text')).toEqual([]);
    expect(SUPPORT_MACRO_PLACEHOLDERS).toEqual(['ticket.subject', 'ticket.category']);
  });

  it('leaves an unknown placeholder as written rather than blanking it', () => {
    expect(fillSupportMacro('Hi {{customer.name}}', values)).toBe('Hi {{customer.name}}');
  });

  it('adds the signature under the draft, and nothing when there is none', () => {
    expect(signedSupportReply('Thanks.', 'Sam, support')).toBe('Thanks.\n\nSam, support');
    expect(signedSupportReply('Thanks.', null)).toBe('Thanks.');
  });

  it('takes a reason and a whole revision on a save', () => {
    const base = { name: 'Card', folder: 'Cards', body: 'Hello', expectedRevision: 0, reason: 'TEST' };
    expect(supportMacroSaveInputSchema.safeParse(base).success).toBe(true);
    expect(supportMacroSaveInputSchema.safeParse({ ...base, reason: ' ' }).success).toBe(false);
    expect(supportMacroSaveInputSchema.safeParse({ ...base, expectedRevision: -1 }).success).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(root.fillSupportMacro).toBe(fillSupportMacro);
  });
});
