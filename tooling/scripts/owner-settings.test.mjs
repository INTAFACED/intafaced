import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build, loadProfile, profileEnvFor, profileExports, render, scanEnvFile } from './owner-settings.mjs';

test('an env entry is an owner setting only when its comment says so', () => {
  const src = `
    /** Plain wiring. */
    HTTP_PORT: z.coerce.number(),
    /**
     * Worst price a market buy may be funded at.
     *
     * NO DEFAULT. Blank refuses \`trade.slippage_cap_unset\`. Never invent 200.
     */
    TRADE_MARKET_SLIPPAGE_CAP_BPS: z.string(),
    /** Where to reach identity. NO DEFAULT. */
    IDENTITY_URL: z.string(),
  `;
  const found = scanEnvFile(src, 'svc-trade');
  assert.deepEqual(
    found.map((f) => f.env),
    ['TRADE_MARKET_SLIPPAGE_CAP_BPS'],
  );
  assert.deepEqual(found[0].codes, ['trade.slippage_cap_unset']);
  assert.match(found[0].what, /^Worst price a market buy/);
});

test('the TEST profile loads only in dev and test', () => {
  const profile = loadProfile();
  assert.match(profile.label, /^TEST/);
  assert.throws(() => profileEnvFor('trade', 'production'), /dev or test/);
  assert.throws(() => profileEnvFor('trade', undefined), /dev or test/);
  assert.throws(() => profileExports(profile, 'staging'), /dev or test/);
  assert.equal(profileEnvFor('trade', 'test').TRADE_MARKET_SLIPPAGE_CAP_BPS, '150');
  assert.ok(profileExports(profile, 'test').includes('export TRADE_MAX_ORDER='));
});

test('every TEST value names its service, is a string and is a listed owner setting or rig value', () => {
  const { values } = loadProfile();
  for (const [name, v] of Object.entries(values)) {
    assert.equal(typeof v.value, 'string', name);
    assert.match(v.service, /^[a-z]+$/, name);
  }
});

test('docs/OWNER-SETTINGS.md matches the code', async () => {
  assert.equal(readFileSync(new URL('../../docs/OWNER-SETTINGS.md', import.meta.url), 'utf8'), await render(build()));
});
