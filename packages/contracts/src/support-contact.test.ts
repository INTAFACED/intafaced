import { describe, expect, it } from 'vitest';
import {
  supportContactChannelsSchema,
  supportContactProblem,
  supportContactSetInputSchema,
  supportContactSetKey,
} from './support-contact.js';
import * as root from './index.js';

describe('support contact channels', () => {
  it('reads a blank channel as null, never as a built-in value', () => {
    const blank = { email: null, phone: null, chatHours: null, revision: 0, updatedAt: null };
    expect(supportContactChannelsSchema.parse(blank)).toEqual(blank);
    expect(supportContactChannelsSchema.safeParse({ ...blank, email: '' }).success).toBe(false);
    expect(supportContactChannelsSchema.safeParse({ ...blank, extra: 1 }).success).toBe(false);
  });

  it.each([
    ['email', 'help@example.test', null],
    ['email', '  help@example.test  ', null],
    ['email', 'not an address', 'not_an_address'],
    ['email', 'a@b', 'not_an_address'],
    ['email', 'a@b.c;d@e.f', 'not_an_address'],
    ['email', '<a@b.test>', 'not_an_address'],
    ['email', 'a@b.test?cc=x.y', 'not_an_address'],
    ['email', 'help@b.test?to=evil%40x.test', 'not_an_address'],
    ['email', 'a@b.test#frag', 'not_an_address'],
    ['email', 'a@b.test%0d%0aBcc', 'not_an_address'],
    ['email', 'a@b.test\u0000', 'not_an_address'],
    ['email', 'a\u202e@b.test', 'not_an_address'],
    ['email', 'a@b.test/..', 'not_an_address'],
    ['email', '.a@b.test', 'not_an_address'],
    ['email', 'a..b@x.test', 'not_an_address'],
    ['email', 'a@-b.test', 'not_an_address'],
    ['email', 'a@b.test.', 'not_an_address'],
    ['email', 'a@b.t', 'not_an_address'],
    ['email', 'first.last+tag@mail.example.test', null],
    ['email', `${'a'.repeat(250)}@b.test`, 'too_long'],
    ['phone', '+1 (555) 010-0199', null],
    ['phone', '555', 'not_a_number'],
    ['phone', 'call me', 'not_a_number'],
    ['phone', '+'.padEnd(40, '1'), 'too_long'],
    ['chatHours', 'Mon to Fri, 09:00 to 17:00 UTC', null],
    ['chatHours', 'open <b>now</b>', 'not_text'],
    ['chatHours', 'line\nbreak', 'not_text'],
    ['chatHours', 'open\u202enow', 'not_text'],
    ['chatHours', 'open\u200bnow', 'not_text'],
    ['phone', '+44 20 7946 0958 ext 12', 'not_a_number'],
    ['chatHours', '   ', 'empty'],
  ] as const)('judges %s %j as %s', (setting, value, expected) => {
    expect(supportContactProblem(setting, value)).toBe(expected);
  });

  it('sets one or more channels, null clears, and a field left out is unchanged', () => {
    const base = { expectedRevision: 0, reason: 'Owner set the address' };
    expect(supportContactSetInputSchema.safeParse({ ...base, email: 'help@example.test' }).success).toBe(true);
    expect(supportContactSetInputSchema.safeParse({ ...base, email: null }).success).toBe(true);
    expect(supportContactSetInputSchema.safeParse({ ...base, phone: '+1 555 010 0199', chatHours: null }).success).toBe(true);
  });

  it('parses a value trimmed, so what was judged is what is stored', () => {
    const parsed = supportContactSetInputSchema.parse({ expectedRevision: 0, reason: 'r', email: '  a@b.test  ', chatHours: ' 9 to 5 ' });
    expect(parsed.email).toBe('a@b.test');
    expect(parsed.chatHours).toBe('9 to 5');
  });

  it.each([
    { expectedRevision: 0, reason: 'r' },
    { expectedRevision: 0, reason: 'r', email: 'nope' },
    { expectedRevision: 0, reason: '', email: 'a@b.test' },
    { expectedRevision: 0, reason: '   ', email: 'a@b.test' },
    { expectedRevision: -1, reason: 'r', email: 'a@b.test' },
    { expectedRevision: 0.5, reason: 'r', email: 'a@b.test' },
    { reason: 'r', email: 'a@b.test' },
    { expectedRevision: 0, reason: 'r', email: 'a@b.test', userId: 'x' },
  ])('refuses a change that is not exactly a valid one: %j', (input) => {
    expect(supportContactSetInputSchema.safeParse(input).success).toBe(false);
  });

  it('logs a change under a business key made from the revision it moves from', () => {
    expect(supportContactSetKey(3)).toBe('support.contact:r3');
    expect(supportContactSetKey(3)).toBe(supportContactSetKey(3));
    expect(supportContactSetKey(4)).not.toBe(supportContactSetKey(3));
  });

  it('is exported from the root', () => {
    expect(root.supportContactSetKey).toBe(supportContactSetKey);
  });
});
