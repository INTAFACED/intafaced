import { describe, expect, it, vi } from 'vitest';
import { fetchTicketLifecycle, readActionReply } from './browser';

describe('the browser’s strict reader for a desk write', () => {
  it('reads a success only when it names a known action and carries the service’s sentence', () => {
    expect(readActionReply({ ok: true, action: 'reply', summary: 'svc-support recorded your reply on the ticket.' })).toEqual({
      ok: true,
      action: 'reply',
      summary: 'svc-support recorded your reply on the ticket.',
    });
  });
  it.each([
    null,
    'ok',
    {},
    { ok: true },
    { ok: true, action: 'reply' },
    { ok: true, action: 'delete', summary: 'x' },
    { ok: 'true', action: 'reply', summary: 'x' },
  ])('turns %j into "outcome not known", never a success', (raw) => {
    const reply = readActionReply(raw);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.refusal.changed).toBe('unknown');
  });
  it('keeps a refusal as the service-side console wrote it', () => {
    const refusal = { title: 'Someone changed this article first', body: 'b', next: 'n', code: 'support.kb.revision_stale', changed: 'no' };
    expect(readActionReply({ ok: false, refusal })).toEqual({ ok: false, refusal });
  });
});

describe('fetchTicketLifecycle', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const answer = (body: unknown, ok = true) => vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok, json: async () => body } as Response);

  it('asks the lifecycle view for that ticket and returns a well-shaped answer', async () => {
    const spy = answer({ asOf: '2026-10-20T04:00:00.000Z', lifecycle: { kind: 'ok', data: {} } });
    const view = await fetchTicketLifecycle(id);
    expect(String(spy.mock.calls[0]![0])).toBe(`/api/support?view=lifecycle&id=${id}`);
    expect(view?.asOf).toBe('2026-10-20T04:00:00.000Z');
    spy.mockRestore();
  });

  it('returns null for a refusal, a wrong shape or a dropped connection, never a guess', async () => {
    let spy = answer({}, false);
    expect(await fetchTicketLifecycle(id)).toBeNull();
    spy.mockRestore();
    spy = answer({ asOf: 'x' });
    expect(await fetchTicketLifecycle(id)).toBeNull();
    spy.mockRestore();
    spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await fetchTicketLifecycle(id)).toBeNull();
    spy.mockRestore();
  });
});
