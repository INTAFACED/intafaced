import { describe, expect, it } from 'vitest';
import { checkOfficialChannel, officialChannelListSchema, officialChannelsAnswerSchema } from './support-official-channels.js';

const list = officialChannelListSchema.parse({
  test: true,
  domains: ['official-test.invalid'],
  senders: ['security@official-test.invalid'],
  channels: [{ label: 'TEST help centre', url: 'https://official-test.invalid/help' }],
});

describe('official channel check (I-signin-sessions-26)', () => {
  it('a listed domain is official however it is typed', () => {
    for (const typed of [
      'official-test.invalid',
      'OFFICIAL-TEST.INVALID.',
      'https://official-test.invalid/login?x=1',
      ' official-test.invalid:443 ',
    ]) {
      expect(checkOfficialChannel(list, typed)).toEqual({ verdict: 'official', shown: 'official-test.invalid' });
    }
  });

  it('a lookalike, a subdomain trick or another domain is not on the list', () => {
    for (const typed of [
      'officials-test.invalid',
      'official-test.invalid.example.invalid',
      'login.official-test.invalid',
      'offical-test.invalid',
      '',
    ]) {
      expect(checkOfficialChannel(list, typed).verdict).toBe('not_listed');
    }
  });

  it('a sender address is checked against the senders, exactly', () => {
    expect(checkOfficialChannel(list, 'Security@Official-Test.invalid').verdict).toBe('official');
    expect(checkOfficialChannel(list, 'support@official-test.invalid').verdict).toBe('not_listed');
  });

  it('an unpublished list is its own answer, and a list with no domain is refused', () => {
    expect(officialChannelsAnswerSchema.parse({ published: false })).toEqual({ published: false });
    expect(() => officialChannelListSchema.parse({ domains: [] })).toThrow();
    expect(() => officialChannelListSchema.parse({ domains: ['Not A Domain'] })).toThrow();
  });
});
