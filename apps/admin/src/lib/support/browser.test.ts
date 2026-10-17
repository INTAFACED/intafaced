import { describe, expect, it } from 'vitest';
import { readActionReply } from './browser';

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
