import { describe, expect, it } from 'vitest';
import {
  SUPPORT_MACRO_PLACEHOLDERS,
  fillSupportMacro,
  supportMacroPlaceholders,
  supportMacroSaveInputSchema,
  supportMacroUnfilled,
  supportMacroUnknownPlaceholders,
} from './support-macros.js';
import * as root from './index.js';

const TICKET = '55555555-5555-4555-8555-555555555555';
const values = { 'requester.name': 'Ada', 'ticket.id': TICKET, 'agent.name': 'Sam' } as const;

describe('support macros', () => {
  it('fills every placeholder in the closed list, spaces inside the braces allowed', () => {
    expect(fillSupportMacro('Hi {{requester.name}}, {{ ticket.id }} is with {{agent.name}}. {{requester.name}}', values)).toBe(
      `Hi Ada, ${TICKET} is with Sam. Ada`,
    );
    expect(SUPPORT_MACRO_PLACEHOLDERS).toEqual(['requester.name', 'ticket.id', 'agent.name']);
  });

  it('leaves a blank value unfilled, never empty and never a stand-in, and names it', () => {
    const text = fillSupportMacro('Hi {{requester.name}}, about {{ticket.id}}.', { ...values, 'requester.name': null });
    expect(text).toBe(`Hi {{requester.name}}, about ${TICKET}.`);
    expect(supportMacroUnfilled(text)).toEqual(['requester.name']);
    expect(fillSupportMacro('Hi {{agent.name}}', { ...values, 'agent.name': '  ' })).toBe('Hi {{agent.name}}');
    expect(supportMacroUnfilled(`About ${TICKET}.`)).toEqual([]);
  });

  it('names the placeholders a body uses and the ones no request can fill', () => {
    expect(supportMacroPlaceholders('{{ticket.id}} {{customer.balance}} {{ticket.id}}')).toEqual(['ticket.id', 'customer.balance']);
    expect(supportMacroUnknownPlaceholders('{{ticket.id}} {{customer.balance}}')).toEqual(['customer.balance']);
    expect(supportMacroUnknownPlaceholders('Plain text')).toEqual([]);
    expect(fillSupportMacro('Hi {{customer.balance}}', values)).toBe('Hi {{customer.balance}}');
    expect(supportMacroUnfilled('Hi {{customer.balance}}')).toEqual([]);
  });

  it('takes a reason, a one-word shortcode and a whole revision on a save', () => {
    const base = { title: 'Card', shortcode: 'card', folder: 'Cards', body: 'Hello', expectedRevision: 0, reason: 'TEST' };
    expect(supportMacroSaveInputSchema.safeParse(base).success).toBe(true);
    expect(supportMacroSaveInputSchema.safeParse({ ...base, reason: ' ' }).success).toBe(false);
    expect(supportMacroSaveInputSchema.safeParse({ ...base, shortcode: 'two words' }).success).toBe(false);
    expect(supportMacroSaveInputSchema.safeParse({ ...base, expectedRevision: -1 }).success).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(root.fillSupportMacro).toBe(fillSupportMacro);
  });
});
