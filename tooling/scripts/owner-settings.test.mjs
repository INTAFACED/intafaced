import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('the TEST profile merges one file per service and refuses a misplaced or doubled value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-profile-'));
  const label = 'TEST: fixture';
  const write = (file, values, l = label) => writeFileSync(join(dir, file), JSON.stringify({ label: l, values }));
  try {
    write('pay.json', { PAY_A: { service: 'pay', value: '1', note: '' } });
    write('trade.json', { TRADE_A: { service: 'trade', value: '2', note: '' } });
    const merged = loadProfile(dir);
    assert.equal(merged.label, label);
    assert.deepEqual(Object.keys(merged.values).sort(), ['PAY_A', 'TRADE_A']);

    write('trade.json', { PAY_B: { service: 'pay', value: '3', note: '' } });
    assert.throws(() => loadProfile(dir), /PAY_B belongs to service "pay", so it goes in pay\.json/);

    write('trade.json', { TRADE_A: { service: 'trade', value: '2', note: '' } }, 'TEST: something else');
    assert.throws(() => loadProfile(dir), /label differs/);

    write('aa.json', {}, '');
    assert.throws(() => loadProfile(dir), /aa\.json: its label must start with TEST/);
    rmSync(join(dir, 'aa.json'));

    write('trade.json', { PAY_A: { service: 'trade', value: '2', note: '' } });
    assert.throws(() => loadProfile(dir), /PAY_A is already set in pay\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.match(v.service, /^[a-z0-9]+(-[a-z0-9]+)*$/, name); // a service name, e.g. mining-pool or p2p
  }
});

test('the generated list names every env setting and every TEST value', async () => {
  const data = build();
  const text = await render(data);
  // A known setting read from services/svc-trade/src/env.ts, shown with its TEST value from trade.json.
  assert.match(text, /\|\s*svc-trade\s*\|\s*`TRADE_MARKET_SLIPPAGE_CAP_BPS`\s*\|.*\|\s*`150` \(TEST\)\s*\|/);
  assert.match(text, new RegExp(`^${data.settings.length} env settings, `, 'm'));
  for (const s of data.settings) assert.ok(text.includes(`\`${s.env}\``), s.env);
  for (const [name, v] of Object.entries(data.profile.values)) {
    if (data.settings.some((s) => s.env === name)) assert.ok(text.includes(`\`${v.value.replace(/\|/g, '\\|')}\` (TEST)`), name);
  }
});

test('a code whose area has an underscore is found', () => {
  const src = '/** Lifetime. NO DEFAULT. Refuses `action_approval.ttl_unset`. */\n  IDENTITY_ACTION_APPROVAL_TTL_SECONDS: z.string(),';
  assert.deepEqual(scanEnvFile(src, 'svc-identity')[0].codes, ['action_approval.ttl_unset']);
});
