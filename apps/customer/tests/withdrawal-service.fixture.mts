import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createPayRouter } from '../../../services/svc-pay/src/router.ts';
import { UserMoneyService } from '../../../services/svc-pay/src/user-money-service.ts';
import { RailRegistry } from '../../../services/svc-pay/src/rails/registry.ts';
const serviceRequire = createRequire(new URL('../../../services/svc-pay/package.json', import.meta.url));
const { fetchRequestHandler } = await import(serviceRequire.resolve('@trpc/server/adapters/fetch'));
const { issueAccessToken, verifyAccessToken } = await import(serviceRequire.resolve('@intafaced/auth'));

// Isolated transport, actual router, SQL reads, row parser and formatter. No
// Postgres, provider, account balance or ledger operation is instantiated.
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreign = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = (key: string, user = owner, amount = '0.000000000000000001') => ({
  id: key,
  user_id: user,
  asset_id: 'USDT',
  amount,
  rail: 'isolated-rail',
  destination: { kind: 'bank', ref: 'private-destination-only-in-memory' },
  client_ref: 'original-only-in-memory',
  rail_ref: null,
  attempts: 1,
  failure_code: null,
  status: 'held',
  created_at: new Date('2026-10-10T09:20:00Z'),
});
const rows = [row(foreign, other), row(id), row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', owner, '99999999999999999999.000000000000000001')];
let reads = 0;
const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  reads++;
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  assert.match(text, /^SELECT /);
  if (text.includes('WHERE user_id = ?')) {
    assert.match(text, /ORDER BY created_at DESC LIMIT \?$/);
    assert.equal(values.length, 2);
    return rows.filter((record) => record.user_id === values[0]).slice(0, values[1] as number);
  }
  assert.match(text, /FROM pay.withdrawals WHERE id = \?$/);
  assert.equal(values.length, 1);
  return rows.filter((record) => record.id === values[0]);
};
const noOperations = new Proxy(
  {},
  {
    get() {
      throw new Error('No money/provider operation is authorized in this read fixture');
    },
  },
);
const service = new UserMoneyService(sql as never, noOperations as never, new RailRegistry([]), { operatorCreditRails: [] });
const router = createPayRouter(noOperations as never, new RailRegistry([]), service);
const config = {
  secret: 'isolated-read-fixture-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const issued = await issueAccessToken(
  { userId: owner, sessionId: '33333333-3333-4333-8333-333333333333', scopes: ['trade:read'], tier: 'none', mfa: false },
  config,
);
const principal = await verifyAccessToken(issued.token, config);
async function request(procedure: string, input: unknown, identity = principal) {
  const response = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request('http://isolated/trpc/' + procedure + '?input=' + encodeURIComponent(JSON.stringify(input))),
    router,
    createContext: () => ({ principal: identity, service: null, region: 'DE', requestId: 'isolated-withdrawal-read' }),
  });
  return { status: response.status, body: await response.json() };
}
test('ordinary non-MFA trade:read reaches actual owner SQL and exact wire formatter', async () => {
  const result = await request('withdrawal.mine', { limit: 50 });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.data.length, 2);
  assert.deepEqual(
    result.body.result.data.map((record: { userId: string; amount: string }) => [record.userId, record.amount]),
    [
      [owner, '0.000000000000000001'],
      [owner, '99999999999999999999.000000000000000001'],
    ],
  );
  assert.equal(result.body.result.data[0].sourceSpaceId, undefined);
  assert.equal(result.body.result.data[0].ledgerTxId, undefined);
});
test('get returns the exact original and actual destination only after owner response gate', async () => {
  const result = await request('withdrawal.get', { withdrawalId: id });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.data.id, id);
  assert.equal(result.body.result.data.destination.ref, rows[1].destination.ref);
  const denied = await request('withdrawal.get', { withdrawalId: foreign });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.result, undefined);
  assert.equal(JSON.stringify(denied.body).includes(rows[0].destination.ref), false);
});
test('actual formatter carries named missing-original code distinct from unknown procedure', async () => {
  const missing = await request('withdrawal.get', { withdrawalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.data.cause.code, 'pay.withdrawal_not_found');
  const absent = await request('withdrawal.absent', {});
  assert.equal(absent.status, 404);
  assert.notEqual(absent.body.error.data.cause?.code, 'pay.withdrawal_not_found');
});
test('unset/out-of-range windows and malformed UUID refuse; anonymous reads never reach SQL', async () => {
  for (const input of [{}, { limit: 201 }, { limit: 0 }]) assert.notEqual((await request('withdrawal.mine', input)).status, 200);
  assert.equal((await request('withdrawal.get', { withdrawalId: 'bad' })).status, 400);
  const before = reads;
  assert.equal((await request('withdrawal.mine', { limit: 50 }, null as never)).status, 401);
  assert.equal(reads, before);
});
