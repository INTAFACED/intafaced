import { expect, it } from 'vitest';
import { parseAmendOrderBody } from './private-rest.js';
it.each([100, true, { a: 1 }])('L378 non-string price %j on amend is refused, not dropped', (price) => {
  const r = parseAmendOrderBody({ qty: '1', price });
  expect(r.ok).toBe(false);
});
