import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { parseSendReviewRule, reviewReason } from './send-review.js';

describe('the owner’s personal send review rule (PP-send-request-10)', () => {
  it('is no rule when unset or blank: no send is held', () => {
    expect(parseSendReviewRule(undefined)).toBeNull();
    expect(parseSendReviewRule('  ')).toBeNull();
    expect(reviewReason(null, 'USDT', parseAmount('1000000'))).toBeNull();
  });

  it('holds a send above its asset’s line, and only that', () => {
    const rule = parseSendReviewRule('{"USDT":"50"}');
    expect(reviewReason(rule, 'USDT', parseAmount('50.000000000000000001'))).toBe('amount_over_review_line');
    expect(reviewReason(rule, 'usdt', parseAmount('60'))).toBe('amount_over_review_line');
    // At the line is not above it; another asset has no line.
    expect(reviewReason(rule, 'USDT', parseAmount('50'))).toBeNull();
    expect(reviewReason(rule, 'BTC', parseAmount('60'))).toBeNull();
  });

  it('refuses boot on anything malformed, so a bad rule never runs quietly', () => {
    for (const raw of ['not json', '[]', '{}', '{"USDT":50}', '{"USDT":"-1"}', '{"USDT":"0"}', '{"usdt":"5"}', '{"USDT":"1e3"}'])
      expect(() => parseSendReviewRule(raw), raw).toThrow(/BANK_PERSONAL_SEND_REVIEW_JSON/);
  });
});
