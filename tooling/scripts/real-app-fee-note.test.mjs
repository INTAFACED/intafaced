// A journey's spot sell that the ledger refused for less base than it asked names the cause in one line
// (apps/customer/tests/real-app/stack.mjs `withFeeNote`): a buy's fee is taken in the asset bought. Failure it prevents:
// #8404 `8cd82aa5`, J-algo-dev-05 #3 sold the 0.001 BTC it had bought and the ledger answered "requested 0.001,
// available 0.000999", a round to learn the fee. Every value here is fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withFeeNote } from '../../apps/customer/tests/real-app/stack.mjs';

const refused = (message) => ({
  status: 400,
  body: { code: 'InsufficientFunds', message, intafacedCode: 'ledger.insufficient_funds' },
});
const SHORT = refused('Insufficient BTC: requested 0.001, available 0.000999');

test('a sell short of what a buy left says the fee is taken in the asset bought, and how to sell what is held', () => {
  const out = withFeeNote('/api/v1/orders', { symbol: 'BTC/USDT', side: 'sell', type: 'market', amount: '0.001' }, SHORT);
  assert.equal(
    out.body.message,
    "Insufficient BTC: requested 0.001, available 0.000999 (journey helper: a buy's fee is taken in the asset bought, so a sell of what was bought asks for more than the buy left; sell what the balance holds, (await api(who).balances()).BTC.free)",
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.intafacedCode, 'ledger.insufficient_funds');
  assert.equal(SHORT.body.message, 'Insufficient BTC: requested 0.001, available 0.000999', 'the answer itself is not changed');
});

test("every other answer is the app's own, untouched", () => {
  const sell = { side: 'sell', amount: '0.001' };
  assert.equal(withFeeNote('/api/v1/orders', { side: 'buy' }, SHORT), SHORT);
  assert.equal(withFeeNote('/api/v1/orders/preview', sell, SHORT), SHORT);
  assert.equal(withFeeNote('/api/bank/trpc/x', sell, SHORT), SHORT);
  const ok = { status: 201, body: { id: 'o1' } };
  assert.equal(withFeeNote('/api/v1/orders', sell, ok), ok);
  const enough = refused('Insufficient BTC: requested 0.001, available 0.002');
  assert.equal(withFeeNote('/api/v1/orders', sell, enough), enough);
  const other = { status: 400, body: { message: 'Insufficient BTC: requested 0.001, available 0', intafacedCode: 'trade.other' } };
  assert.equal(withFeeNote('/api/v1/orders', sell, other), other);
});
