import { describe, expect, it } from 'vitest';
import { plainFailure } from '../refusal';
import './refusals';

describe('sanctions screening refusals', () => {
  it.each([
    ['pay.guard_screening_unavailable', /sanctions screening isn’t available right now/],
    ['pay.guard_screening_review', /compliance review/],
    ['pay.guard_screening_refuse', /can’t send money to this recipient/],
  ])('%s reads as plain words and says nothing was sent', (code, words) => {
    const out = plainFailure({ ok: false, reason: 'error', code, message: code });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toMatch(words);
      expect(out.message).toMatch(/^Nothing was sent/);
      expect(out.message).not.toMatch(/pay\./);
    }
  });
});
