import { afterEach, describe, expect, it, vi } from 'vitest';
import { crmWrite, workflowUrl, type PendingCrmWrite } from './crm-browser';
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
