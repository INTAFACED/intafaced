import fs from 'node:fs';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hlRecordingPath } from '../../../../tooling/scripts/local-test-venue.mjs';

// How a venue file that opts in to Hyperliquid's test network runs: live on main's daily run, which writes its
// recording (.github/workflows/hl-venue-daily.yml), and from that recording everywhere else. No Playwright here, so the
// choice is tested beside it (hl-file-run.test.mjs).

/** Set to `1` by the daily Hyperliquid workflow only: an opted-in file then runs live and writes its recording. */
const HL_LIVE_ENV = 'HL_VENUE_LIVE';

/** The GitHub secret (and env var) with the funded Hyperliquid test-network wallet's key: what a live file signs with. */
export const HL_TRADER_KEY_ENV = 'HL_TESTNET_TRADER_KEY';

/**
 * The key a replayed file's wallet signs with, derived from a public name: it holds nothing anywhere. The replay matches
 * requests with the trader normalised out and writes this wallet's address back where the recording has the trader.
 */
export const HL_REPLAY_KEY = keccak256(toHex('intafaced TEST Hyperliquid replay trader'));

/** A Hyperliquid file asked for what it lacks: `code` names it. */
export class HyperliquidFileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The funded test-network wallet's key from HL_TESTNET_TRADER_KEY, `0x`-prefixed and lowercase. MetaMask exports it
 * without `0x`, so both forms are read. Unset refuses `hl_live_key_missing`, naming the secret. Never printed.
 */
export function hlLiveKey(env = process.env) {
  const text = (env[HL_TRADER_KEY_ENV] ?? '').trim();
  if (text === '')
    throw new HyperliquidFileError(
      'hl_live_key_missing',
      `LOCAL_STACK_USER_VENUE=hl-testnet needs ${HL_TRADER_KEY_ENV}, the funded test-network wallet's key: it is not set`,
    );
  const hex = /^0x/i.test(text) ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{64}$/.test(hex))
    throw new HyperliquidFileError('hl_live_key_malformed', `${HL_TRADER_KEY_ENV} must be 64 hex digits, with or without 0x`);
  return `0x${hex.toLowerCase()}`;
}

/** Whether a recording of this name is on disk. */
const hlRecordingExists = (recording) => fs.existsSync(hlRecordingPath(recording));

/**
 * How an opted-in file runs, as `{ kind, key, trader }`: `kind` is the venue switch venue.mjs `venueForThisFile` takes,
 * `key` the private key the file's browser wallet signs with and `trader` its address.
 * - `HL_VENUE_LIVE=1` (the daily workflow on main): `hl-testnet`, signing with the funded test-network wallet, writing
 *   the recording live. No key refuses `hl_live_key_missing`.
 * - Its recording exists: `hl-recorded`, signing with the public replay key; a request the recording has no answer for
 *   fails the file (venueForThisFile's afterAll), never answered by the simulator.
 * - No recording yet: the file runs on the TEST venue simulator (`on`) exactly as before it opted in, with `key` and
 *   `trader` null (the file keeps its own fresh TEST wallet), until the daily run's pull request adds its recording.
 */
export function hyperliquidFileRun(recording, { env = process.env, recorded = hlRecordingExists } = {}) {
  hlRecordingPath(recording); // a bad name throws here, before anything starts
  if (env[HL_LIVE_ENV] === '1') {
    const key = hlLiveKey(env);
    return { kind: 'hl-testnet', key, trader: privateKeyToAccount(key).address.toLowerCase() };
  }
  if (recorded(recording))
    return { kind: 'hl-recorded', key: HL_REPLAY_KEY, trader: privateKeyToAccount(HL_REPLAY_KEY).address.toLowerCase() };
  return { kind: 'on', key: null, trader: null };
}
