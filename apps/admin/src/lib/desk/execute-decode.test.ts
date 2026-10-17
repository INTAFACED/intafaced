import { describe, expect, it } from 'vitest';
import type { ToggleResult } from '@/lib/control-plane-contract';
import { decodeFreezeExecute, decodeKillExecute } from './execute-decode';

const snap = (killed: boolean) => ({ disabledModules: killed ? (['trade'] as const) : [], reasons: {}, audit: [] });
const intent = { module: 'trade', disabled: true, reason: 'market integrity incident' } as const;
const result = (over: Partial<ToggleResult>): ToggleResult => ({
  ok: false,
  status: 400,
  snapshot: snap(false),
  detail: null,
  intent,
  ...over,
});

describe('the edge’s answer to an approved kill', () => {
  it('a decoded success is reported as what the edge said, not as the new state', () => {
    const r = decodeKillExecute(result({ ok: true, status: 200, snapshot: snap(true) }));
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.detail).toContain('returned snapshot lists trade as killed');
  });
  it('"not approved yet" inside the edge’s wrapped sentence is a definite refusal that changed nothing', () => {
    const r = decodeKillExecute(
      result({
        code: 'action_approval.consume_failed',
        detail: 'identity refused consumeForEdge (412) approval is PENDING [action_approval.not_approved]',
        uncertain: true,
      }),
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal.changed).toBe('no');
    expect(!r.ok && r.refusal.title).toContain('has not approved');
  });
  it('an unclassified failure the edge flagged uncertain stays "not known"', () => {
    const r = decodeKillExecute(result({ code: 'edge.invalid_kill_switch', status: 400, detail: 'something odd', uncertain: true }));
    expect(!r.ok && r.refusal.changed).toBe('unknown');
  });
  it('an unconfigured console is a definite "nothing was sent"', () => {
    const r = decodeKillExecute(result({ code: 'admin.kill_unconfigured', status: 503, uncertain: false }));
    expect(!r.ok && r.refusal.changed).toBe('no');
    expect(!r.ok && r.refusal.title).toContain('not set up');
  });
});

describe('the ledger’s answer to an approved freeze or unfreeze', () => {
  const record = (frozen: boolean) => ({
    frozen,
    reason: frozen ? 'reconciliation mismatch' : null,
    actor: 'op',
    changedAt: '2026-10-17T03:00:00.000Z',
  });
  it('2xx counts only when the returned record shows the requested state', () => {
    expect(decodeFreezeExecute({ reached: true, status: 200, body: record(true) }, true)).toMatchObject({ ok: true });
    expect(decodeFreezeExecute({ reached: true, status: 200, body: record(false) }, false)).toMatchObject({ ok: true });
  });
  it('a 2xx with the wrong or an unreadable record is "not known", never success', () => {
    for (const body of [record(false), {}, null, 'ok']) {
      const r = decodeFreezeExecute({ reached: true, status: 200, body }, true);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.refusal.changed).toBe('unknown');
    }
  });
  it('a typed approval refusal changed nothing', () => {
    const r = decodeFreezeExecute(
      { reached: true, status: 400, body: { message: 'x [action_approval.not_approved]', code: 'action_approval.consume_failed' } },
      true,
    );
    expect(!r.ok && r.refusal.changed).toBe('no');
  });
  it('an untyped 5xx may or may not have changed something', () => {
    const r = decodeFreezeExecute({ reached: true, status: 502, body: null }, true);
    expect(!r.ok && r.refusal.changed).toBe('unknown');
  });
  it('an untyped 4xx is a definite refusal; a dropped connection is not known; an unconfigured console sent nothing', () => {
    expect(
      (
        decodeFreezeExecute(
          { reached: true, status: 409, body: { message: 'first reason stands', code: 'ledger.freeze_attributed' } },
          true,
        ) as { refusal: { changed: string } }
      ).refusal.changed,
    ).toBe('no');
    const dropped = decodeFreezeExecute({ reached: false, sent: true, detail: 'x' }, true);
    expect(!dropped.ok && dropped.refusal.changed).toBe('unknown');
    const unconfigured = decodeFreezeExecute({ reached: false, sent: false, detail: 'x' }, true);
    expect(!unconfigured.ok && unconfigured.refusal.changed).toBe('no');
  });
});
