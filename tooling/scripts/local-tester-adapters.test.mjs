/**
 * Unit tests for local-tester-adapters (the tester compose stack's TEST chain and venue): what the venue waits for.
 * No chain, no network.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordedUsdToken } from './local-tester-adapters.mjs';

test("the venue takes the TEST USD the chain's seed recorded, and nothing before the seed ran", () => {
  const usd = '0x' + 'ab'.repeat(20);
  assert.equal(
    recordedUsdToken('/state', () => JSON.stringify({ tokens: { USD: { address: usd } } })),
    usd,
  );
  assert.equal(
    recordedUsdToken('/state', () => {
      throw new Error('ENOENT');
    }),
    null,
  );
  assert.equal(
    recordedUsdToken('/state', () => JSON.stringify({ tokens: {} })),
    null,
  );
  assert.equal(
    recordedUsdToken('/state', () => JSON.stringify({ tokens: { USD: { address: 'not-an-address' } } })),
    null,
  );
});
