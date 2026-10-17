import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AT_FETCH_TIME,
  crmJson,
  type CrmBrowserError,
  crmOverdueCalendarDays,
  crmUpdatedText,
  crmWrite,
  readFailureKeepsValue,
  resolveFetchTime,
  workflowUrl,
  type PendingCrmWrite,
} from './crm-browser';
afterEach(() => vi.unstubAllGlobals());
describe('CRM ambiguous write retry', () => {
  it('retains request UUID and CSRF on uncertain responses, then clears only after confirmed JSON', async () => {
    const pending = new Map<string, PendingCrmWrite>(),
      input = { opportunityId: 'opportunity', expectedRevision: 4, reason: 'Reviewed' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('Lost acknowledgement'))
      .mockResolvedValueOnce(new Response('not-json'))
      .mockResolvedValueOnce(Response.json({ saved: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(crmWrite('actual-csrf', pending, 'createTask', input)).rejects.toThrow();
    const id = pending.get('createTask')!.requestId;
    await expect(crmWrite('actual-csrf', pending, 'createTask', input)).rejects.toThrow();
    expect(pending.get('createTask')?.requestId).toBe(id);
    expect(await crmWrite('actual-csrf', pending, 'createTask', input)).toEqual({ saved: true });
    expect(pending.size).toBe(0);
    for (const [, options] of fetcher.mock.calls) {
      expect(JSON.parse(String(options?.body)).input.requestId).toBe(id);
      expect(new Headers(options?.headers).get('x-intafaced-csrf')).toBe('actual-csrf');
    }
  });
  it('keeps bounded reads scoped and omits empty filters', () => {
    expect(workflowUrl('listTasks', { limit: 50, opportunityId: 'owned', ownerUserId: '', cursor: undefined })).toBe(
      '/api/crm/workflows?view=listTasks&limit=50&opportunityId=owned',
    );
  });
});

describe('CRM read freshness', () => {
  it('resolves the fetch-time marker to the time of each fetch, so a later refetch moves the overdue cut-off', () => {
    const input = { limit: 50, dueBefore: AT_FETCH_TIME };
    const first = workflowUrl('listTasks', resolveFetchTime(input, '2026-10-15T10:00:00.000Z'));
    const later = workflowUrl('listTasks', resolveFetchTime(input, '2026-10-15T10:01:00.000Z'));
    expect(first).toContain('dueBefore=2026-10-15T10%3A00%3A00.000Z');
    expect(later).toContain('dueBefore=2026-10-15T10%3A01%3A00.000Z');
    expect(first).not.toBe(later);
    expect(workflowUrl('listTasks', input)).toContain('dueBefore=%40now'); // the key stays stable for the hook, so the marker alone never refetches
  });
  it('a failed reload keeps the value only when it came from the same request', () => {
    expect(readFailureKeepsValue('/api/crm/workflows?view=metrics', '/api/crm/workflows?view=metrics')).toBe(true);
    expect(readFailureKeepsValue('/api/crm/workflows?view=metrics', '/api/crm/workflows?view=metrics&audience=investor')).toBe(false);
    expect(readFailureKeepsValue(null, '/api/crm/workflows?view=metrics')).toBe(false); // first load fails loudly, as before
  });
});

describe('overdue calendar days', () => {
  const TZ = process.env.TZ;
  afterEach(() => {
    if (TZ === undefined) delete process.env.TZ;
    else process.env.TZ = TZ;
  });
  it('counts local calendar days, not 24-hour blocks', () => {
    process.env.TZ = 'Asia/Makassar'; // UTC+8
    const now = Date.parse('2026-10-15T02:00:00Z'); // 10:00 on the 15th locally
    expect(crmOverdueCalendarDays('2026-10-15T00:30:00Z', now)).toBe(0); // 08:30 today
    expect(crmOverdueCalendarDays('2026-10-14T15:00:00Z', now)).toBe(1); // 23:00 yesterday: only 11 hours ago, still "1 day"
    expect(crmOverdueCalendarDays('2026-10-13T01:00:00Z', now)).toBe(2);
  });
  it('is not thrown off by the 25-hour day when the clocks go back', () => {
    process.env.TZ = 'America/New_York';
    const now = Date.parse('2026-11-02T17:00:00Z'); // 12:00 EST on 2 Nov
    expect(crmOverdueCalendarDays('2026-11-01T04:30:00Z', now)).toBe(1); // 00:30 EDT on 1 Nov
  });
});

describe('CRM refusal wording', () => {
  const refuse = (status: number, body: unknown) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })));
    return crmJson('/api/crm/workflows?view=metrics').catch((error: unknown) => error as CrmBrowserError);
  };
  it('says CRM is not configured, with no reload action, for the three unconfigured service codes', async () => {
    for (const upstream of ['ops.crm.configuration_unverified', 'ops.crm.storage_unconfigured', 'ops.crm.authority_unconfigured']) {
      const error = await refuse(412, { code: 'admin.upstream_refused', upstream });
      expect(error).toMatchObject({ kind: 'unconfigured', message: 'CRM is not configured on this deployment.' });
    }
  });
  it('keeps "the record changed" for a real version conflict and for a 412 that names no code', async () => {
    expect(await refuse(412, { code: 'admin.upstream_refused', upstream: 'ops.crm.revision_conflict' })).toMatchObject({
      kind: 'conflict',
    });
    expect(await refuse(412, { code: 'admin.upstream_refused' })).toMatchObject({ kind: 'conflict' });
  });
  it('calls a definite refusal refused with nothing changed, not unconfirmed and not a changed record', async () => {
    for (const status of [409, 412]) {
      const error = await refuse(status, { code: 'admin.upstream_refused', upstream: 'ops.crm.opportunity_closed' });
      expect(error).toMatchObject({ kind: 'refused' });
      expect((error as Error).message).toBe('This action was refused and nothing was changed. Refresh and review before retrying.');
      expect((error as Error).message).not.toMatch(/changed or|could not confirm/);
    }
  });
  it('keeps "could not confirm" for a failure that may have gone through', async () => {
    expect(await refuse(502, { code: 'admin.upstream_invalid' })).toMatchObject({ kind: 'other' });
  });
});

describe('the workspace "Updated" line', () => {
  it('names the time and its zone in the shared form, whatever the Mac’s clock is', () => {
    expect(crmUpdatedText('2026-10-18T02:58:05.123Z')).toBe('Updated 02:58:05 UTC');
  });
  it('says the time is unknown rather than printing the raw text', () => {
    expect(crmUpdatedText('soon')).toBe('Updated unknown time');
  });
});
