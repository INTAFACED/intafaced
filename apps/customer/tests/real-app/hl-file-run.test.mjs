import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { HL_REPLAY_KEY, hlLiveKey, hyperliquidFileRun } from './hl-file-run.mjs';

// How an opted-in venue file runs: live only where the daily workflow says so, replayed when its recording
// exists, on the simulator until it does. A planted TEST key below, derived from a public name; it holds nothing.
const KEY = privateKeyToAccount(`0x${'ab'.repeat(32)}`);
const RAW = 'ab'.repeat(32);
const never = () => false;
const always = () => true;

describe('hyperliquidFileRun', () => {
  it('runs live with the funded key only when HL_VENUE_LIVE=1, read with or without 0x', () => {
    for (const key of [RAW, `0x${RAW}`, `  0X${RAW.toUpperCase()}\n`]) {
      const run = hyperliquidFileRun('J-x-venue', { env: { HL_VENUE_LIVE: '1', HL_TESTNET_TRADER_KEY: key }, recorded: always });
      expect(run).toEqual({ kind: 'hl-testnet', key: `0x${RAW}`, trader: KEY.address.toLowerCase() });
    }
  });

  it('refuses a live run with no key or a malformed one, naming the secret', () => {
    expect(() => hyperliquidFileRun('J-x-venue', { env: { HL_VENUE_LIVE: '1' }, recorded: always })).toThrow(
      expect.objectContaining({ code: 'hl_live_key_missing', message: expect.stringContaining('HL_TESTNET_TRADER_KEY') }),
    );
    expect(() => hlLiveKey({ HL_TESTNET_TRADER_KEY: '0x1234' })).toThrow(expect.objectContaining({ code: 'hl_live_key_malformed' }));
  });

  it('replays with the public replay key when the recording exists, and never live without HL_VENUE_LIVE=1', () => {
    for (const live of [undefined, '', '0', 'true']) {
      const run = hyperliquidFileRun('J-x-venue', { env: { HL_VENUE_LIVE: live, HL_TESTNET_TRADER_KEY: RAW }, recorded: always });
      expect(run).toEqual({ kind: 'hl-recorded', key: HL_REPLAY_KEY, trader: privateKeyToAccount(HL_REPLAY_KEY).address.toLowerCase() });
    }
  });

  it('runs on the simulator with its own wallet until the first recording exists', () => {
    expect(hyperliquidFileRun('J-x-venue', { env: {}, recorded: never })).toEqual({ kind: 'on', key: null, trader: null });
  });

  it('refuses a recording name that is not a plain file name', () => {
    expect(() => hyperliquidFileRun('../x', { env: {}, recorded: never })).toThrow(/letters, digits/);
  });

  it('finds the recording on disk by its name', () => {
    expect(hyperliquidFileRun('order-btc-perp', { env: {} }).kind).toBe('hl-recorded');
    expect(hyperliquidFileRun('no-such-recording', { env: {} }).kind).toBe('on');
  });
});
