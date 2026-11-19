/**
 * Tests for call-graph.mjs: tooling/shape/call-graph.json is the call graph of the code as it is.
 * No network. Run: node --test tooling/shape/call-graph.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { NOT_A_CALL, OUT, callsInSource, graphFrom, render, servicesOf, sourcesOf, targetOf } from './call-graph.mjs';

const committed = readFileSync(new URL(`../../${OUT}`, import.meta.url), 'utf8');
const sources = sourcesOf();

test('the committed call graph is current (run `node tooling/shape/call-graph.mjs` to refresh it)', async () => {
  assert.equal(await render(graphFrom(sources)), committed);
});

test('every service directory under services/ is a key', () => {
  assert.deepEqual(Object.keys(JSON.parse(committed).services), servicesOf());
});

test("svc-tax's row is its ledger reads, trade prices and activity, and bank spaces", () => {
  const { services } = JSON.parse(committed);
  assert.deepEqual(services['svc-tax'].calls, ['svc-bank', 'svc-ledger', 'svc-trade']);
  assert.ok(services['svc-ledger'].calledBy.includes('svc-tax'));
});

test('a planted new client call changes the graph, so the committed file is stale', async () => {
  const planted = {
    ...sources,
    'svc-quant': [
      ...sources['svc-quant'],
      'const spaces = createBankOwnSpacesClient({ bankUrl: env.BANK_URL, secret: env.INTERNAL_SERVICE_SECRET });\n',
    ],
  };
  const graph = graphFrom(planted);
  assert.ok(graph.services['svc-quant'].calls.includes('svc-bank'));
  assert.ok(graph.services['svc-bank'].calledBy.includes('svc-quant'));
  assert.notEqual(await render(graph), committed);
});

test('a comment, a marked line and a service of its own settings are not calls', () => {
  const services = ['svc-bank', 'svc-indexer', 'svc-pay', 'svc-tax', 'svc-trade'];
  const src = [
    '// BANK_URL is unset: no spaces',
    '/* PAY_URL',
    '   TRADE_URL */',
    `x(env.INDEXER_URL); // ${NOT_A_CALL} only says whether it is set`,
    "const s = 'http://example//not-a-comment'; y(env.TAX_EXPORT_RPC_URL);",
  ].join('\n');
  assert.deepEqual([...callsInSource(src, 'svc-tax', services)], []);
});

test('address variables name the service they point at', () => {
  const services = ['svc-bank', 'svc-fix', 'svc-identity', 'svc-matching', 'svc-mining-pool', 'svc-pay', 'svc-trade'];
  assert.equal(targetOf('BANK_URL', 'svc-pay', services), 'svc-bank');
  assert.equal(targetOf('IDENTITY_CLOSURE_BANK_URL', 'svc-identity', services), 'svc-bank');
  assert.equal(targetOf('MATCHING_BASE_URL', 'svc-fix', services), 'svc-matching');
  assert.equal(targetOf('MINING_POOL_URL', 'svc-bank', services), 'svc-mining-pool');
  assert.equal(targetOf('TRADE_USER_VENUE_URLS', 'svc-trade', services), null);
  assert.equal(targetOf('BANK_TEST_PAY_IN_RPC_URL', 'svc-bank', services), null);
  assert.equal(targetOf('DATABASE_URL', 'svc-bank', services), null);
});
