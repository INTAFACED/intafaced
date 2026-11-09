import { describe, expect, it } from 'vitest';
import { router } from '@intafaced/contracts';
import { officialChannelProcedures, officialChannelsFromEnv } from './official-channels.js';

const LIST = JSON.stringify({ test: true, domains: ['official-test.invalid'], senders: ['security@official-test.invalid'] });

describe('official channel list (I-signin-sessions-26)', () => {
  it('blank is unpublished, and the procedure says so', async () => {
    expect(officialChannelsFromEnv(undefined)).toBeNull();
    const caller = router(officialChannelProcedures(null)).createCaller({} as never);
    expect(await caller.officialChannels()).toEqual({ published: false });
  });

  it('a set list is served as published, with its TEST label', async () => {
    const list = officialChannelsFromEnv(LIST);
    const caller = router(officialChannelProcedures(list)).createCaller({} as never);
    expect(await caller.officialChannels()).toEqual({
      published: true,
      test: true,
      domains: ['official-test.invalid'],
      senders: ['security@official-test.invalid'],
      channels: [],
    });
  });

  it('a value that is not a valid list refuses, never a partial list', () => {
    expect(() => officialChannelsFromEnv('not json')).toThrow('not JSON');
    expect(() => officialChannelsFromEnv(JSON.stringify({ domains: [] }))).toThrow('not a valid list');
    expect(() => officialChannelsFromEnv(JSON.stringify({ domains: ['ok.invalid'], extra: 1 }))).toThrow('not a valid list');
  });
});
