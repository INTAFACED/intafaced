import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { PayError } from '../payment-service.js';
import { SubscriptionService, assertMandateTermsUnchanged, normaliseSubscriptionPath } from './subscription-service.js';

/**
 * Re-consent refuse is pure — no Postgres. Full create/cancel DB suite lands
 * when CI has TEST_DATABASE_URL (schema 0010); the SPEC load-bearing refuse is
 * this code path.
 */
describe('normaliseSubscriptionPath (no silent crypto invent)', () => {
  it('defaults to crypto_invoice', () => {
    expect(normaliseSubscriptionPath(undefined)).toBe('crypto_invoice');
  });

  it('accepts crypto_invoice and card', () => {
    expect(normaliseSubscriptionPath('crypto_invoice')).toBe('crypto_invoice');
    expect(normaliseSubscriptionPath('card')).toBe('card');
  });

  it('aliases card_mandate → card (fire refuses rail absent)', () => {
    expect(normaliseSubscriptionPath('card_mandate')).toBe('card');
  });

  it('REFUSES unknown paths that used to open a crypto invoice', () => {
    try {
      normaliseSubscriptionPath('card_pull_invented');
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(PayError);
      expect((e as PayError).code).toBe('pay.subscription_invalid');
    }
  });
});

describe('assertMandateTermsUnchanged (SPEC §4 re-consent)', () => {
  const base = {
    amount: parseAmount('10'),
    ceiling: parseAmount('20') as typeof parseAmount extends never ? never : ReturnType<typeof parseAmount> | null,
  };

  it('allows identical terms (no throw)', () => {
    expect(() =>
      assertMandateTermsUnchanged(
        { amount: parseAmount('10'), ceiling: parseAmount('20') },
        { amount: parseAmount('10'), ceiling: parseAmount('20') },
      ),
    ).not.toThrow();
  });

  it('REFUSES a raised amount — pay.subscription_reconsent_required', () => {
    try {
      assertMandateTermsUnchanged({ amount: parseAmount('10'), ceiling: null }, { amount: parseAmount('11'), ceiling: null });
      throw new Error('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(PayError);
      expect((e as PayError).code).toBe('pay.subscription_reconsent_required');
    }
  });

  it('REFUSES a ceiling change', () => {
    try {
      assertMandateTermsUnchanged(
        { amount: parseAmount('10'), ceiling: parseAmount('20') },
        { amount: parseAmount('10'), ceiling: parseAmount('30') },
      );
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PayError).code).toBe('pay.subscription_reconsent_required');
    }
  });

  it('REFUSES clearing a ceiling (null) when one was set', () => {
    try {
      assertMandateTermsUnchanged({ amount: parseAmount('10'), ceiling: parseAmount('20') }, { amount: parseAmount('10'), ceiling: null });
      throw new Error('should have refused');
    } catch (e) {
      expect((e as PayError).code).toBe('pay.subscription_reconsent_required');
    }
  });
});

/**
 * Due-pass and resume behavior for a fee-resolver blip, without Postgres.
 * The stand-in only answers the reads and the pause/resume writes those two
 * methods issue. A charge insert is a failure: these cases must not bill.
 */
describe('fee resolver blip (L728)', () => {
  const JAN = new Date('2026-01-01T00:00:00.000Z');
  const DUE = new Date('2026-02-01T00:00:00.000Z');
  const ANCHOR = new Date('2026-01-15T00:00:00.000Z');
  const MAY = new Date('2026-05-01T00:00:00.000Z');
  const WINDOW_END = new Date('2026-07-01T00:00:00.000Z');
  const SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const MANDATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const MERCHANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  function harness(input: {
    status?: 'active' | 'paused';
    stallReason?: 'fee_unpublished' | 'operator_pause' | null;
    endsAt?: Date | null;
    resolveMerchantFeeBps: () => Promise<number | undefined>;
  }) {
    const mandate = {
      id: MANDATE,
      merchant_id: MERCHANT,
      customer_id: 'cust-fee-blip',
      asset_id: 'USDT',
      amount: '10',
      ceiling: null as string | null,
      cadence: 'monthly' as const,
      starts_at: JAN,
      ends_at: input.endsAt === undefined ? null : input.endsAt,
      rail_adapter: null,
      rail_mandate_ref: null,
      status: 'active' as const,
      cancelled_at: null,
      created_at: JAN,
    };
    const subscription = {
      id: SUB,
      mandate_id: MANDATE,
      merchant_id: MERCHANT,
      customer_id: 'cust-fee-blip',
      next_run_at: DUE,
      status: input.status ?? 'active',
      cancelled_at: null,
      path: 'crypto_invoice',
      created_at: JAN,
      anchor_at: ANCHOR,
      anchor_occurrence: 2,
      paused_at: null as Date | null,
      resumed_at: null as Date | null,
      stalled_at: input.stallReason ? JAN : null,
      updated_at: JAN,
      stall_reason: input.stallReason ?? null,
    };
    const openInvoice = vi.fn(async () => {
      throw new Error('fee blip must not charge');
    });
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(' ');
      if (text.includes('INSERT') || (text.includes('pay.subscription_executions') && text.includes('UPDATE'))) {
        throw new Error('fee blip must not claim a period or invent an amount');
      }
      if (text.includes('FROM pay.subscription_executions')) return Promise.resolve([]);
      if (text.includes('FROM pay.subscription_mandates')) {
        return Promise.resolve(values[0] === mandate.id ? [{ ...mandate }] : []);
      }
      if (text.includes('FROM pay.subscriptions') && text.includes('next_run_at <=')) {
        const now = values[0] as Date;
        const limit = values[1] as number;
        const due = subscription.status === 'active' && subscription.next_run_at.getTime() <= now.getTime() ? [{ ...subscription }] : [];
        return Promise.resolve(due.slice(0, limit));
      }
      if (text.includes('FROM pay.subscriptions') && text.includes('WHERE id =')) {
        return Promise.resolve(values[0] === subscription.id ? [{ ...subscription }] : []);
      }
      if (text.includes('UPDATE pay.subscriptions') && text.includes("SET status = 'paused'")) {
        if (values[3] !== subscription.id || subscription.status !== 'active') return Promise.resolve([]);
        subscription.status = 'paused';
        subscription.stalled_at = values[0] as Date;
        subscription.stall_reason = values[1] as typeof subscription.stall_reason;
        subscription.updated_at = values[2] as Date;
        return Promise.resolve([{ ...subscription }]);
      }
      if (text.includes('UPDATE pay.subscriptions') && text.includes("stall_reason = 'fee_unpublished'")) {
        const id = values[values.length - 1];
        if (id !== subscription.id || subscription.status !== 'paused' || subscription.stall_reason !== 'fee_unpublished') {
          return Promise.resolve([]);
        }
        subscription.status = 'active';
        subscription.resumed_at = values[0] as Date;
        subscription.paused_at = null;
        subscription.stalled_at = null;
        subscription.stall_reason = null;
        subscription.updated_at = values[1] as Date;
        return Promise.resolve([{ ...subscription }]);
      }
      if (text.includes('UPDATE pay.subscriptions') && text.includes('anchor_at =')) {
        if (values[5] !== subscription.id || subscription.status !== 'paused') return Promise.resolve([]);
        subscription.status = 'active';
        subscription.anchor_at = values[0] as Date;
        subscription.anchor_occurrence = values[1] as number;
        subscription.next_run_at = values[2] as Date;
        subscription.resumed_at = values[3] as Date;
        subscription.paused_at = null;
        subscription.stalled_at = null;
        subscription.stall_reason = null;
        subscription.updated_at = values[4] as Date;
        return Promise.resolve([{ ...subscription }]);
      }
      throw new Error(`unhandled subscription sql: ${text.replace(/\s+/g, ' ').slice(0, 240)}`);
    }) as unknown as Sql;

    const subs = new SubscriptionService(sql, () => MAY, openInvoice, {
      resolveMerchantFeeBps: input.resolveMerchantFeeBps,
    });
    return { subs, openInvoice, subscription };
  }

  it('leaves the row active when resolveFeeBps throws a transient error, so the next due pass still sees it', async () => {
    const { subs, openInvoice } = harness({
      resolveMerchantFeeBps: async () => {
        throw new Error('resolver connection reset');
      },
    });

    const first = await subs.runDueSubscriptions({ limit: 50, now: MAY });
    const second = await subs.runDueSubscriptions({ limit: 50, now: MAY });
    const row = await subs.getSubscription(SUB);

    expect(first.examined).toBe(1);
    expect(first.fired).toBe(0);
    expect(first.stalled).toBe(0);
    expect(first.outcomes[0]).toMatchObject({ outcome: 'skipped', subscriptionId: SUB });
    expect(first.outcomes[0]!.stallReason).toBeUndefined();
    expect(first.outcomes[0]!.rejectionCode).not.toBe('pay.subscription_fee_unpublished');
    expect(second.examined).toBe(1);
    expect(second.stalled).toBe(0);
    expect(row.status).toBe('active');
    expect(row.stallReason).toBeNull();
    expect(row.nextRunAt.toISOString()).toBe(DUE.toISOString());
    expect(row.anchorAt?.toISOString()).toBe(ANCHOR.toISOString());
    expect(row.anchorOccurrence).toBe(2);
    expect(openInvoice).not.toHaveBeenCalled();
  });

  it('does not record a non-unpublished PayError as fee_unpublished and does not pause', async () => {
    const { subs, openInvoice } = harness({
      resolveMerchantFeeBps: async () => {
        throw new PayError('merchant row unreadable', 'pay.merchant_not_found');
      },
    });

    const report = await subs.runDueSubscriptions({ limit: 50, now: MAY });
    const row = await subs.getSubscription(SUB);

    expect(report.stalled).toBe(0);
    expect(report.fired).toBe(0);
    expect(report.outcomes[0]).toMatchObject({
      outcome: 'skipped',
      rejectionCode: 'pay.merchant_not_found',
    });
    expect(report.outcomes[0]!.stallReason).toBeUndefined();
    expect(row.status).toBe('active');
    expect(row.stallReason).toBeNull();
    expect(row.nextRunAt.toISOString()).toBe(DUE.toISOString());
    expect(row.anchorAt?.toISOString()).toBe(ANCHOR.toISOString());
    expect(row.anchorOccurrence).toBe(2);
    expect(openInvoice).not.toHaveBeenCalled();
  });

  it('still stalls an unpublished fee and does not charge', async () => {
    const { subs, openInvoice } = harness({
      resolveMerchantFeeBps: async () => {
        throw new PayError('no rate published', 'pay.subscription_fee_unpublished');
      },
    });

    const report = await subs.runDueSubscriptions({ limit: 50, now: MAY });
    const again = await subs.runDueSubscriptions({ limit: 50, now: MAY });
    const row = await subs.getSubscription(SUB);

    expect(report.stalled).toBe(1);
    expect(report.fired).toBe(0);
    expect(report.outcomes[0]).toMatchObject({
      outcome: 'stalled',
      stallReason: 'fee_unpublished',
      rejectionCode: 'pay.subscription_fee_unpublished',
    });
    expect(again.examined).toBe(0);
    expect(row.status).toBe('paused');
    expect(row.stallReason).toBe('fee_unpublished');
    expect(row.nextRunAt.toISOString()).toBe(DUE.toISOString());
    expect(row.anchorAt?.toISOString()).toBe(ANCHOR.toISOString());
    expect(row.anchorOccurrence).toBe(2);
    expect(openInvoice).not.toHaveBeenCalled();
  });

  it('restores the stored due time when a fee_unpublished stall resumes', async () => {
    const { subs } = harness({
      status: 'paused',
      stallReason: 'fee_unpublished',
      endsAt: WINDOW_END,
      resolveMerchantFeeBps: async () => 250,
    });

    const { subscription, projectedEnd } = await subs.resumeSubscription(SUB);

    expect(subscription.status).toBe('active');
    expect(subscription.stallReason).toBeNull();
    expect(subscription.nextRunAt.toISOString()).toBe(DUE.toISOString());
    expect(subscription.anchorAt?.toISOString()).toBe(ANCHOR.toISOString());
    expect(subscription.anchorOccurrence).toBe(2);
    expect(projectedEnd).toBeNull();
    const stored = await subs.getSubscription(SUB);
    expect(stored.nextRunAt.toISOString()).toBe(DUE.toISOString());
    expect(stored.anchorAt?.toISOString()).toBe(ANCHOR.toISOString());
    expect(stored.anchorOccurrence).toBe(2);
  });

  it('still re-anchors an operator pause on resume', async () => {
    const { subs } = harness({
      status: 'paused',
      stallReason: 'operator_pause',
      resolveMerchantFeeBps: async () => 250,
    });

    const { subscription } = await subs.resumeSubscription(SUB);

    expect(subscription.status).toBe('active');
    expect(subscription.stallReason).toBeNull();
    expect(subscription.nextRunAt.toISOString()).toBe(MAY.toISOString());
    expect(subscription.anchorAt?.toISOString()).toBe(MAY.toISOString());
    expect(subscription.anchorOccurrence).toBe(0);
  });

  it('still refuses an operator resume that would re-space past the mandate window', async () => {
    const { subs } = harness({
      status: 'paused',
      stallReason: 'operator_pause',
      endsAt: WINDOW_END,
      resolveMerchantFeeBps: async () => 250,
    });

    await expect(subs.resumeSubscription(SUB)).rejects.toMatchObject({
      code: 'pay.subscription_resume_exceeds_mandate',
    });
    const row = await subs.getSubscription(SUB);
    expect(row.status).toBe('paused');
    expect(row.stallReason).toBe('operator_pause');
    expect(row.nextRunAt.toISOString()).toBe(DUE.toISOString());
    expect(row.anchorAt?.toISOString()).toBe(ANCHOR.toISOString());
    expect(row.anchorOccurrence).toBe(2);
  });
});
