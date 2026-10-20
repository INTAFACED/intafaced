import { describe, expect, it } from 'vitest';
import {
  quantDisclosureAcceptInputSchema,
  quantDisclosureAcceptKey,
  quantDisclosureCountsOutputSchema,
  quantDisclosureCurrentSchema,
  quantDisclosurePublishInputSchema,
  quantDisclosureStatusOutputSchema,
} from './quant-disclosure.js';
import * as root from './index.js';

describe('quant disclosure', () => {
  it('writes an acceptance under a business key, never a random one', () => {
    expect(quantDisclosureAcceptKey('s-1', 3, 2)).toBe('quant.disclose:s-1:v3:2');
    expect(quantDisclosureAcceptKey('s-1', 3, 2)).toBe(quantDisclosureAcceptKey('s-1', 3, 2));
    expect(quantDisclosureAcceptKey('s-1', 4, 2)).not.toBe(quantDisclosureAcceptKey('s-1', 3, 2));
    expect(quantDisclosureAcceptKey('s-1', 3, 3)).not.toBe(quantDisclosureAcceptKey('s-1', 3, 2));
  });

  it('knows unpublished apart from published, and an unpublished record carries no wording', () => {
    expect(quantDisclosureCurrentSchema.safeParse({ published: false }).success).toBe(true);
    expect(
      quantDisclosureCurrentSchema.safeParse({ published: true, version: 1, text: 'x', publishedAt: '2026-10-20T12:00:00.000Z' }).success,
    ).toBe(true);
    expect(
      quantDisclosureCurrentSchema.safeParse({ published: true, version: 1, text: '', publishedAt: '2026-10-20T12:00:00.000Z' }).success,
    ).toBe(false);
    expect(
      quantDisclosureCurrentSchema.safeParse({ published: true, version: 0, text: 'x', publishedAt: '2026-10-20T12:00:00.000Z' }).success,
    ).toBe(false);
  });

  it.each([
    { strategyId: '', strategyVersion: 1, disclosureVersion: 1 },
    { strategyId: 's', strategyVersion: 0, disclosureVersion: 1 },
    { strategyId: 's', strategyVersion: 1, disclosureVersion: 0 },
    { strategyId: 's', strategyVersion: 1.5, disclosureVersion: 1 },
    { strategyId: 's', strategyVersion: 1 },
  ])('refuses an acceptance that does not name a strategy, a strategy version and a disclosure version: %j', (input) => {
    expect(quantDisclosureAcceptInputSchema.safeParse(input).success).toBe(false);
  });

  it('takes the account from the session, never the body', () => {
    const parsed = quantDisclosureAcceptInputSchema.parse({ strategyId: 's', strategyVersion: 1, disclosureVersion: 1, accountId: 'x' });
    expect(parsed).not.toHaveProperty('accountId');
  });

  it('needs wording, a reason and a key to publish', () => {
    expect(quantDisclosurePublishInputSchema.safeParse({ text: 'w', reason: 'r', idempotencyKey: 'k' }).success).toBe(true);
    expect(quantDisclosurePublishInputSchema.safeParse({ text: '  ', reason: 'r', idempotencyKey: 'k' }).success).toBe(false);
    expect(quantDisclosurePublishInputSchema.safeParse({ text: 'w', reason: '', idempotencyKey: 'k' }).success).toBe(false);
    expect(quantDisclosurePublishInputSchema.safeParse({ text: 'w', reason: 'r', idempotencyKey: '' }).success).toBe(false);
  });

  it('keeps the counts view free of accounts, strategies and wording', () => {
    const parsed = quantDisclosureCountsOutputSchema.parse({
      versions: [{ version: 1, publishedAt: '2026-10-20T12:00:00.000Z', acceptances: 4, userId: 'u', text: 'w' }],
      asOf: '2026-10-20T12:00:00.000Z',
    });
    expect(Object.keys(parsed.versions[0] ?? {}).sort()).toEqual(['acceptances', 'publishedAt', 'version']);
  });

  it('shows an unaccepted status with no time', () => {
    expect(
      quantDisclosureStatusOutputSchema.safeParse({
        strategyId: 's',
        strategyVersion: 1,
        disclosure: { published: false },
        accepted: false,
        acceptedAt: null,
      }).success,
    ).toBe(true);
  });

  it('is exported from the root', () => {
    expect(root.quantDisclosureAcceptKey).toBe(quantDisclosureAcceptKey);
  });
});
