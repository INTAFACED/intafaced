import { expect, it } from 'vitest';
import { parseCopyRelationshipState } from './copy-lifecycle.js';
it('L365 unrecognized non-empty state must not become ACTIVE', () => {
  let out: unknown;
  try {
    out = parseCopyRelationshipState('PAUSD');
  } catch {
    return;
  }
  expect(out).not.toBe('ACTIVE');
});
