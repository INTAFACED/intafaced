import { expect, it } from 'vitest';
import { TradeService } from '../trade-service.js';
import { withComboPlace } from '../combo-place.js';
import { layered } from '../../layered.js';
it('L388 combo:false with legs present does not become combo:true on the engine request', () => {
  const proto = layered(TradeService, withComboPlace).prototype as any;
  const input = {
    clientOrderId: 'c',
    side: 'buy',
    type: 'limit',
    price: 1n,
    qty: 1n,
    combo: false,
    legs: [{ name: 'a', ratio: 1n, strike: 1n, expiry: '2030-01-01' }],
  };
  const req = proto.toEngineRequest.call({}, 'oid', 'uid', input, 'limit', 'GTC', null, {} as never);
  expect(req.combo).not.toBe(true);
});
