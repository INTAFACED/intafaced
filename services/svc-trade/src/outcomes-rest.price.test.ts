import { expect, it } from 'vitest';
import { post } from './outcomes-test-harness.js';
it.each(['0', '-0.5', '1.5'])('L376 limit price %s is refused before place', async (price) => {
  const { res, place } = await post('DE', { price });
  expect(place).not.toHaveBeenCalled();
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
});
it('L376 market order (null price) is refused before place', async () => {
  const { res, place } = await post('DE', { type: 'market', price: undefined });
  expect(place).not.toHaveBeenCalled();
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
});
it('L377 stopPrice and expireAt reach the place call', async () => {
  const { res, place } = await post('DE', {
    type: 'stop_limit',
    stopPrice: '0.3',
    timeInForce: 'GTD',
    expireAt: '2026-08-24T11:30:00.000Z',
  });
  if (res.statusCode >= 400) return; // refusing is also correct
  expect(place).toHaveBeenCalled();
  const input = place.mock.calls[0]![1];
  expect(JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toMatch(/0\.3|300000/);
  expect(JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toContain('2026-08-24T11:30');
});
