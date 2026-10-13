import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crmRetentionStatusSchema } from '@intafaced/contracts';
import { RetentionPolicySummary, retentionReviewWrite, type PendingRetentionReview } from './crm-privacy';
import { crmDate } from '../lib/crm-browser';

const contactId = randomUUID(),
  founderId = randomUUID(),
  now = new Date().toISOString();

describe('retention context', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the configured policy, paused automation, and last sweep as distinct facts', () => {
    const status = crmRetentionStatusSchema.parse({
      status: 'configured',
      inactivityCalendarMonths: 6,
      clockTimeZone: 'UTC',
      activeReviewMaxDays: 30,
      automationEnabled: false,
      lastSweepAt: now,
    });
    const html = renderToStaticMarkup(<RetentionPolicySummary status={status} />);
    expect(html).toContain('Retention policy configured');
    expect(html).toContain('automatic deletion paused');
    expect(html).toContain('last sweep');
    expect(html).toContain(crmDate(now));
  });

  it('retains the same request UUID and exact body after an unknown receipt, then accepts only the matching review', async () => {
    const pending: { current: PendingRetentionReview | null } = { current: null };
    const draft = {
      canonicalContactId: contactId,
      expectedCanonicalRevision: 4,
      expectedReviewRevision: 0,
      state: 'active' as const,
      evidenceRef: 'meeting-note-17',
      reason: 'Founder confirmed discussion remains active.',
    };
    const result = {
      reviewId: randomUUID(),
      canonicalContactId: contactId,
      revision: 1,
      state: 'active',
      reviewedBy: founderId,
      reviewedAt: now,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      evidenceRef: draft.evidenceRef,
      reason: draft.reason,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(Response.json({ ...result, canonicalContactId: randomUUID() }))
      .mockResolvedValueOnce(Response.json(result));
    vi.stubGlobal('fetch', fetcher);
    await expect(retentionReviewWrite('synthetic-csrf', pending, draft, contactId)).rejects.toThrow();
    const firstBody = fetcher.mock.calls[0]?.[1]?.body;
    const firstRequest = JSON.parse(String(firstBody));
    expect(firstRequest.action).toBe('privacyRetentionReview');
    expect(firstRequest.input.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstRequest.input).toEqual({ ...draft, requestId: firstRequest.input.requestId });
    await expect(
      retentionReviewWrite('synthetic-csrf', pending, { ...draft, reason: 'Changed while the result is unknown.' }, contactId),
    ).rejects.toThrow('previous review is unconfirmed');
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(retentionReviewWrite('synthetic-csrf', pending, draft, contactId)).rejects.toThrow('could not be confirmed');
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(firstBody);
    expect(await retentionReviewWrite('synthetic-csrf', pending, draft, contactId)).toEqual(result);
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(firstBody);
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('x-intafaced-csrf')).toBe('synthetic-csrf');
    expect(pending.current).toBeNull();
  });

  it('clears the exact pending command only for a verified stale-state refusal', async () => {
    const pending: { current: PendingRetentionReview | null } = { current: null };
    const draft = {
      canonicalContactId: contactId,
      expectedCanonicalRevision: 4,
      expectedReviewRevision: 0,
      state: 'inactive' as const,
      evidenceRef: 'meeting-note-18',
      reason: 'Discussion has ended.',
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ code: 'admin.upstream_refused' }, { status: 412 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(retentionReviewWrite('synthetic-csrf', pending, draft, contactId)).rejects.toThrow('contact or review changed');
    expect(pending.current).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
