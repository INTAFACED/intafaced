import { expect, it } from 'vitest';
import { checkAccess } from '@intafaced/config';
import { post } from './outcomes-test-harness.js';
it('L375 outcome order is refused when region is blocked', async () => {
  const blocked = ['KP', 'IR', 'CU', 'SY', 'US'].find(
    (r) => !checkAccess({ module: 'trade', plane: 'fiat', region: r, kycTier: 'basic' }).allowed,
  );
  expect(blocked, 'need a region checkAccess blocks').toBeDefined();
  const { res, place } = await post(blocked!, {});
  expect(place).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(403);
});
