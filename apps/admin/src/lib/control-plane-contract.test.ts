import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeRead, decodeSnapshot, decodeToggle, type ToggleInput } from './control-plane-contract';
import { fetchKillSwitches, postKillSwitch } from './control-plane-browser';
const zero = { disabledModules: [], reasons: {}, audit: [] };
const event = {
  at: '2026-10-09T16:00:00.000Z',
  module: 'trade',
  actor: 'historical-actor',
  confirmOperatorId: 'historical-confirmer',
  reason: 'Isolated historical incident',
  previous: false,
  next: true,
  changed: true,
};
const intent: ToggleInput = { module: 'trade', disabled: true, reason: 'Original isolated incident' };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('strict module read data', () => {
  it('distinguishes a valid zero snapshot from absent data', () => {
    expect(decodeRead(zero, 200, false).status).toBe('reachable');
    expect(decodeRead({}, 200, false).status).toBe('invalid_response');
    expect(decodeSnapshot({ ...zero, audit: [event] })?.audit[0]?.actor).toBe('historical-actor');
  });
  it.each([
    null,
    {},
    { ...zero, disabledModules: ['invented-module'] },
    { ...zero, disabledModules: ['trade', 'trade'] },
    { ...zero, reasons: { trade: 0 } },
    { ...zero, reasons: { invented: 'reason' } },
    { ...zero, audit: {} },
    { ...zero, audit: [{ ...event, actor: '' }] },
    { ...zero, audit: [{ ...event, at: 'yesterday' }] },
    { ...zero, audit: [{ ...event, previous: 'false' }] },
    { ...zero, audit: [{ ...event, changed: false }] },
    { ...zero, audit: [{ ...event, confirmOperatorId: 7 }] },
  ])('refuses malformed snapshots without reporting live zero: %j', (body) => {
    const state = decodeRead(body, 200, false);
    expect(state.status).toBe('invalid_response');
    expect(state.code).toBe('admin.kill_invalid_response');
  });
  it.each([
    [401, 'admin.bff_gate', 'refused'],
    [403, 'insufficient_scope', 'refused'],
    [503, 'admin.bff_gate_unconfigured', 'unconfigured'],
    [503, 'admin.kill_invalid_response', 'invalid_response'],
    [502, 'edge.unreachable', 'unreachable'],
  ] as const)('preserves refusal %s %s', (status, code, expected) => {
    const state = decodeRead({ code, error: 'Isolated refusal' }, status, true);
    expect(state).toMatchObject({ status: expected, code, httpStatus: status, detail: 'Isolated refusal' });
  });
  it('rejects a browser envelope that asserts an unavailable snapshot as reachable', () => {
    expect(decodeRead({ status: 'unconfigured', snapshot: zero, detail: null }, 200, true).status).toBe('invalid_response');
  });
  it('browser GET uses only same-origin no-store and decodes unreadable success', async () => {
    const fetch = vi.fn(async () => new Response('unreadable', { status: 200 }));
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      url === '/api/session' ? Promise.resolve(Response.json({ csrf: 'A'.repeat(43) })) : fetch(url, init),
    );
    expect((await fetchKillSwitches()).status).toBe('invalid_response');
    expect(fetch).toHaveBeenCalledWith('/api/kill-switch', expect.objectContaining({ cache: 'no-store' }));
  });
});
describe('retained command helper preserves original uncertainty without replay', () => {
  it.each([
    null,
    {},
    { ...zero, disabledModules: [] },
    { disabledModules: ['trade'], reasons: {}, audit: [{ ...event, changed: 'true' }] },
  ])('unreadable or malformed success is unresolved: %j', (body) => {
    const result = decodeToggle(body, 200, intent, false);
    expect(result).toMatchObject({ ok: false, uncertain: true, intent });
  });
  it('5xx is unresolved; typed pre-dispatch configuration and authoritative 400 refusals are distinct', () => {
    expect(decodeToggle({}, 503, intent, false).uncertain).toBe(true);
    expect(decodeToggle({ code: 'admin.kill_unconfigured' }, 503, intent, false).uncertain).toBe(false);
    expect(decodeToggle({ code: 'action_approval.missing', error: 'approvalId is required' }, 400, intent, false)).toMatchObject({
      ok: false,
      uncertain: false,
      code: 'action_approval.missing',
      intent,
    });
  });
  it('later state and historical tally cannot change an earlier unresolved result', () => {
    const original = decodeToggle(null, 200, intent, false);
    expect(decodeRead({ ...zero, disabledModules: ['trade'], audit: [event] }, 200, false).status).toBe('reachable');
    expect(original).toMatchObject({ ok: false, uncertain: true, intent });
  });
  it('transport snapshot explicitly lacks original operation/current human proof', () => {
    const result = decodeToggle({ ...zero, disabledModules: ['trade'], audit: [event] }, 200, intent, false);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('original operation lookup and current human identity are unavailable');
  });
  it('browser timeout freezes original input and never retries or adds authority fields', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error('Isolated timeout');
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      url === '/api/session' ? Promise.resolve(Response.json({ csrf: 'A'.repeat(43) })) : fetch(url, init),
    );
    const original = { ...intent };
    const result = await postKillSwitch(original);
    original.reason = 'Later reason';
    expect(result).toMatchObject({ ok: false, uncertain: true, intent });
    expect(Object.isFrozen(result.intent)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(intent);
  });
});

describe('audit instants require real calendar/time/offset fields', () => {
  it.each([
    '2026-02-30T09:00:00.000Z',
    '2026-02-29T09:00:00.000Z',
    '1900-02-29T09:00:00.000Z',
    '2026-04-31T09:00:00.000Z',
    '2026-13-01T09:00:00.000Z',
    '2026-10-00T09:00:00.000Z',
    '2026-10-09T24:00:00.000Z',
    '2026-10-09T09:60:00.000Z',
    '2026-10-09T09:00:60.000Z',
    '2026-10-09T09:00:00.000+24:00',
    '2026-10-09T09:00:00.000+05:60',
  ])('rejects impossible instant %s', (at) => {
    expect(decodeRead({ ...zero, audit: [{ ...event, at }] }, 200, false)).toMatchObject({
      status: 'invalid_response',
      code: 'admin.kill_invalid_response',
    });
  });
  it.each(['2024-02-29T09:00:00.000Z', '2000-02-29T09:00:00.000Z', '2024-02-29T09:00:00.000+05:30', '2024-02-29T09:00:00.000-04:00'])(
    'preserves a valid leap/offset instant %s exactly',
    (at) => {
      const state = decodeRead({ ...zero, audit: [{ ...event, at }] }, 200, false);
      expect(state.status).toBe('reachable');
      expect(state.snapshot.audit[0]?.at).toBe(at);
    },
  );
});

describe('browser command envelopes cannot turn contradictory HTTP200 into a definite outcome', () => {
  const snapshot = { ...zero, disabledModules: ['trade'], audit: [event] };
  const valid = { ok: true, status: 200, snapshot, detail: null, uncertain: false };
  it.each([
    { ...valid, ok: false },
    { ...valid, status: 403 },
    { ...valid, status: '200' },
    { ...valid, detail: undefined },
    { ...valid, detail: [] },
    { ...valid, uncertain: true },
    { ...valid, uncertain: 'false' },
    { ...valid, code: 7 },
  ])('retains frozen original intent for malformed success %j', (body) => {
    const original = Object.freeze({ ...intent });
    const result = decodeToggle(body, 200, original, true);
    expect(result).toMatchObject({ ok: false, uncertain: true, code: 'admin.kill_invalid_command_response', intent: original });
    expect(result.intent).toBe(original);
  });
  it('accepts the actual well-formed transport envelope only as a snapshot', () => {
    expect(decodeToggle(valid, 200, intent, true)).toMatchObject({ ok: true, uncertain: false, intent });
    expect(decodeToggle(valid, 200, intent, true).detail).toContain('original operation lookup and current human identity are unavailable');
  });
  it('actual browser helper treats false200 as unresolved with exactly one isolated request', async () => {
    const fetch = vi.fn(async () => Response.json({ ...valid, ok: false, status: 400, code: 'action_approval.missing' }));
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      url === '/api/session' ? Promise.resolve(Response.json({ csrf: 'A'.repeat(43) })) : fetch(url, init),
    );
    const result = await postKillSwitch(intent);
    expect(result).toMatchObject({ ok: false, uncertain: true, intent });
    expect(Object.isFrozen(result.intent)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('unclassified non2xx cannot settle an original command after approval may have started', () => {
  it.each([
    [400, 'edge.invalid_kill_request'],
    [400, 'action_approval.consume_failed'],
    [403, 'scope.insufficient'],
    [409, 'operation.conflict'],
  ])('retains uncertainty for HTTP%s code%s', (status, code) => {
    const original = Object.freeze({ ...intent });
    const result = decodeToggle({ code, error: 'Isolated failure after a possible operation start' }, status as number, original, false);
    expect(result).toMatchObject({ ok: false, uncertain: true, code, intent: original });
    expect(result.intent).toBe(original);
  });
  it.each([
    [401, 'admin.bff_gate'],
    [403, 'admin.bff_gate_origin'],
    [400, 'action_approval.missing'],
    [400, 'action_approval.identity_unwired'],
  ])('known pre-dispatch boundary HTTP%s code%s stays a definite refusal', (status, code) => {
    expect(decodeToggle({ code, error: 'Isolated pre-dispatch refusal' }, status as number, intent, false)).toMatchObject({
      ok: false,
      uncertain: false,
      code,
      intent,
    });
  });
});
