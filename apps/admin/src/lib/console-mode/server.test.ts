import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConsoleModeBanner } from '@/components/console-mode-banner';
import { consoleModeExecute, loadConsoleMode } from './server';

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ids = { approvalId: 'appr_1', operationId: 'op_1' };
const mode = (readOnly: boolean) => ({
  readOnly,
  reason: readOnly ? 'TEST database maintenance window' : null,
  revision: readOnly ? 3 : 4,
  changedAt: '2026-10-24T08:00:00.000Z',
  requesterId: '11111111-1111-4111-8111-111111111111',
  approverId: '33333333-3333-4333-8333-333333333333',
  asOf: '2026-10-24T08:00:01.000Z',
});
const ok = (data: unknown) => Response.json({ result: { data } });
const refused = (code: string) =>
  Response.json(
    { error: { message: `${code} — refused`, code: -32603, data: { code: 'PRECONDITION_FAILED', httpStatus: 412, cause: { code } } } },
    { status: 412 },
  );

afterEach(() => vi.unstubAllGlobals());

describe('maintenance mode reads', () => {
  it('reads the mode as the founder from svc-ops', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok(mode(true)));
    vi.stubGlobal('fetch', fn);
    const read = await loadConsoleMode(ctx);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/ops/trpc/consoleMode.get');
    expect((fn.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(read.view).toMatchObject({ kind: 'read', mode: { readOnly: true, reason: 'TEST database maintenance window' } });
  });

  it('no storage is off by construction; a failed or malformed read is unknown, never off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refused('ops.console_mode_storage_unconfigured')),
    );
    expect((await loadConsoleMode(ctx)).view).toEqual({ kind: 'unconfigured' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    expect((await loadConsoleMode(ctx)).view).toMatchObject({ kind: 'unknown', message: 'svc-ops did not answer.' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ readOnly: 'yes' })),
    );
    expect((await loadConsoleMode(ctx)).view.kind).toBe('unknown');
  });

  it('the banner shows only when the mode is on or not known', () => {
    const on = renderToStaticMarkup(ConsoleModeBanner({ view: { kind: 'read', mode: mode(true) } }));
    expect(on).toContain('this console is read-only');
    expect(on).toContain('TEST database maintenance window');
    expect(
      renderToStaticMarkup(ConsoleModeBanner({ view: { kind: 'unknown', message: 'svc-ops did not answer.', code: null } })),
    ).toContain('Writes are not held');
    expect(ConsoleModeBanner({ view: { kind: 'read', mode: mode(false) } })).toBeNull();
    expect(ConsoleModeBanner({ view: { kind: 'unconfigured' } })).toBeNull();
  });
});

describe('maintenance mode change', () => {
  it('turning on sends the action, the reason and both approval ids, and is done only when the mode is on', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) =>
      ok({ mode: mode(true), outcome: 'changed', idempotencyKey: 'ops.console_mode.on:appr_1' }),
    );
    vi.stubGlobal('fetch', fn);
    const result = await consoleModeExecute(ctx)({ kind: 'ops.console_mode.on', reason: 'TEST database maintenance window' }, ids);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/ops/trpc/consoleMode.set');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({
      action: 'ops.console_mode.on',
      reason: 'TEST database maintenance window',
      ...ids,
    });
    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining('maintenance mode is on') });
  });

  it('a replay is done whatever the mode is now: a later change may have moved it on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ mode: mode(false), outcome: 'replayed', idempotencyKey: 'ops.console_mode.on:appr_1' })),
    );
    const result = await consoleModeExecute(ctx)({ kind: 'ops.console_mode.on', reason: 'TEST database maintenance window' }, ids);
    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining('already stored') });
  });

  it('turning off sends no reason; an answer in the other state is never reported done', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) =>
      ok({ mode: mode(true), outcome: 'noop', idempotencyKey: 'ops.console_mode.off:appr_1' }),
    );
    vi.stubGlobal('fetch', fn);
    const result = await consoleModeExecute(ctx)({ kind: 'ops.console_mode.off' }, ids);
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ action: 'ops.console_mode.off', ...ids });
    expect(result.ok).toBe(false);
  });

  it('a refusal from svc-ops comes back in words with its code, and another request kind is refused here', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refused('ops.console_mode_storage_unconfigured')),
    );
    const result = await consoleModeExecute(ctx)({ kind: 'ops.console_mode.off' }, ids);
    expect(result).toMatchObject({ ok: false, refusal: { code: 'ops.console_mode_storage_unconfigured', changed: 'no' } });
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await consoleModeExecute(ctx)({ kind: 'ledger.unfreeze', version: '1' }, ids)).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
