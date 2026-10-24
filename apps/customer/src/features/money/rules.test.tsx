import { describe, expect, it } from 'vitest';
import { choiceWords } from './Rules';
import { bankReads, rulesWrites } from './contracts';
import { rulesCopy } from './rules-copy';

/** BK-acct-10 screen half (J-bank-06 #6): the reminder rule's shape and how each notification choice reads. */

const t = rulesCopy.forLocale('en').t;
const row = (patch: Partial<Parameters<typeof choiceWords>[1] & object> = {}) => ({
  category: 'orders' as const,
  channel: 'email' as const,
  enabled: true,
  locked: false,
  configured: true,
  notConnected: null,
  ...patch,
});

describe('rules and notifications', () => {
  it('reads the bank answer as its schema, and refuses a lead time the bank does not offer', () => {
    const view = bankReads['rules.get'].parse({
      reminder: { ruleKey: 'reminder:u1', leadHours: 48, revision: 2, updatedAt: '2026-11-01T00:00:00.000Z' },
      leadChoices: [24, 48, 72, 168],
      moneyRules: { state: 'not_set', code: 'bank.rule_terms_unset' },
    });
    expect(view.reminder?.ruleKey).toBe('reminder:u1');
    expect(() => rulesWrites.setReminder.parse({ ruleKey: 'reminder:u1', leadHours: 5, revision: 1, updatedAt: 'x' })).toThrow();
  });

  it('says what each channel does with the bank notices, as the notification service holds it', () => {
    expect(choiceWords(t, row())).toBe('On');
    expect(choiceWords(t, row({ enabled: false }))).toBe('Off');
    expect(choiceWords(t, row({ channel: 'in_app' as never, locked: true }))).toBe('Always on');
    expect(choiceWords(t, row({ notConnected: 'vendor.push' as never }))).toContain('vendor.push');
    expect(choiceWords(t, row({ configured: false }))).toContain('Not set up');
    expect(choiceWords(t, undefined)).toContain('did not say');
  });
});
