import { describe, expect, it } from 'vitest';
import { decodeFreezeCommand, decodeFreezeRead, decodeFreezeState } from './ledger-freeze-contract';
const state = { frozen: false, reason: null, actor: null, changedAt: '2026-10-09T16:00:00.000Z' };
const intent = Object.freeze({ frozen: true, reason: 'Original opaque incident <x> & Δ' });
describe('strict standing posting record', () => {
  it('distinguishes a valid not-frozen record and nullable attribution from missing data', () => {
    expect(decodeFreezeRead(state, 200, false)).toMatchObject({ ok: true, kind: 'reachable', state });
    expect(decodeFreezeState({ ...state, actor: 'env:LEDGER_POSTING_ENABLED', reason: '<script>opaque</script>' })).toEqual({
      ...state,
      actor: 'env:LEDGER_POSTING_ENABLED',
      reason: '<script>opaque</script>',
    });
  });
  for (const field of ['frozen', 'reason', 'actor', 'changedAt'])
    it(`requires ${field}`, () => {
      const body: Record<string, unknown> = { ...state };
      delete body[field];
      expect(decodeFreezeRead(body, 200, false)).toMatchObject({ ok: false, kind: 'invalid_response', state: null, upstreamStatus: 200 });
    });
  for (const bad of [
    null,
    [],
    {},
    { ...state, frozen: 0 },
    { ...state, reason: {} },
    { ...state, actor: 1 },
    { ...state, changedAt: null },
  ])
    it(`rejects malformed shape ${JSON.stringify(bad)}`, () => expect(decodeFreezeState(bad)).toBeNull());
  for (const changedAt of [
    '2026-02-30T09:00:00.000Z',
    '2025-02-29T00:00:00Z',
    '2026-04-31T09:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+24:00',
    '2026-01-01T00:00:00+00:60',
    'yesterday',
    '2026-01-01',
  ])
    it(`rejects impossible/unqualified timestamp ${changedAt}`, () => expect(decodeFreezeState({ ...state, changedAt })).toBeNull());
  for (const changedAt of ['2024-02-29T23:59:59.999Z', '2000-02-29T00:00:00Z', '2026-10-09T23:30:01.123456+08:00'])
    it(`preserves valid timestamp bytes ${changedAt}`, () => expect(decodeFreezeState({ ...state, changedAt })?.changedAt).toBe(changedAt));
  it('binds the browser envelope to real HTTP success and required result fields', () => {
    const wire = { ok: true, status: 200, kind: 'reachable', state, detail: null };
    expect(decodeFreezeRead(wire, 200, true).state).toEqual(state);
    for (const bad of [
      { ...wire, ok: false },
      { ...wire, status: 403 },
      { ...wire, kind: 'refused' },
      { ...wire, detail: {} },
    ])
      expect(decodeFreezeRead(bad, 200, true).kind).toBe('invalid_response');
    expect(decodeFreezeRead(wire, 403, true)).toMatchObject({ ok: false, kind: 'refused', state: null });
  });
  for (const [status, kind, code] of [
    [404, 'absent', 'edge.no_route'],
    [403, 'refused', 'scope.denied'],
    [503, 'unconfigured', 'admin.bff_gate_unconfigured'],
    [500, 'unreachable', 'ledger.operator_request_failed'],
  ] as const)
    it(`keeps ${status} distinct from a standing record`, () =>
      expect(decodeFreezeRead({ error: 'Opaque refusal', code }, status, true)).toMatchObject({
        status,
        kind,
        state: null,
        detail: 'Opaque refusal',
        code,
      }));
});
describe('original command uncertainty', () => {
  for (const body of [null, {}, { ok: false, code: 'action_approval.missing' }, state, { ...state, frozen: true }])
    it(`never treats HTTP200 standing/malformed body as original receipt ${JSON.stringify(body)}`, () =>
      expect(decodeFreezeCommand(body, 200, intent, false)).toMatchObject({ ok: false, uncertain: true, intent, state: null }));
  for (const [code, status] of [
    ['admin.bff_gate', 401],
    ['admin.bff_gate_origin', 403],
    ['admin.bff_gate_unconfigured', 503],
    ['admin.ledger_invalid_request', 400],
    ['admin.ledger_unconfigured', 503],
    ['edge.ledger_unreachable', 503],
    ['action_approval.missing', 400],
    ['action_approval.identity_unwired', 400],
  ] as const)
    it(`recognizes only verified pre-effect ${code}/${status}`, () => {
      expect(decodeFreezeCommand({ error: 'Refused before dispatch', code }, status, intent, false)).toMatchObject({
        uncertain: false,
        intent,
      });
      expect(decodeFreezeCommand({ error: 'Contradictory', ok: true, code }, status, intent, false).uncertain).toBe(true);
      expect(decodeFreezeCommand({ code }, 200, intent, false).uncertain).toBe(true);
      expect(decodeFreezeCommand({ code }, status === 400 ? 403 : 400, intent, false).uncertain).toBe(true);
    });
  for (const [status, code] of [
    [400, 'ledger.operator_request_failed'],
    [400, 'action_approval.consume_failed'],
    [409, 'ledger.freeze_attributed'],
    [403, 'scope.denied'],
    [500, 'edge.ledger_unavailable'],
    [502, 'admin.ledger_outcome_unresolved'],
  ] as const)
    it(`keeps unverified/post-effect ${status}/${code} unresolved`, () =>
      expect(decodeFreezeCommand({ error: 'Unverified effect', code }, status, intent, false)).toMatchObject({
        uncertain: true,
        intent,
        state: null,
      }));
  it('keeps a returned standing record separate from original request input', () => {
    const result = decodeFreezeCommand(state, 200, intent, false);
    expect(result.returnedState).toEqual(state);
    expect(result.intent).toBe(intent);
    expect(result.ok).toBe(false);
    expect(
      decodeFreezeCommand({ ...result, returnedState: { ...state, changedAt: null } }, 200, intent, true).returnedState,
    ).toBeUndefined();
  });
});
