import { describe, expect, it } from 'vitest';
import type { ApprovalPacket } from './approval-packet';
import { describePacketStatus, requestGate, roleFor, shortId, stepGate } from './desk-model';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const packet: ApprovalPacket = {
  request: { kind: 'edge.kill', module: 'trade', disabled: true, reason: 'market integrity incident' },
  approvalId: 'appr_1',
  operationId: 'op_1',
  expiresAt: '2026-10-17T03:10:00.000Z',
  requesterId: A,
};
const NOW = new Date('2026-10-17T03:00:00.000Z');
const step = (over: Partial<Parameters<typeof stepGate>[0]> = {}) =>
  stepGate({ step: 'approve', packet, userId: B, confirm: 'KILL trade', blockedReason: null, busy: false, now: NOW, ...over });

describe('who is on which side of a request', () => {
  it('the proposer is the requester and anyone else holding the packet is the second founder', () => {
    expect(roleFor(packet, A)).toBe('requester');
    expect(roleFor(packet, A.toUpperCase())).toBe('requester');
    expect(roleFor(packet, B)).toBe('approver');
    expect(roleFor(packet, '')).toBe('unknown');
    expect(describePacketStatus('requester')).toContain('different founder approves');
    expect(describePacketStatus('unknown')).toContain('not known');
  });
});

describe('the request form stays shut until everything is true', () => {
  const ok = {
    reason: 'market integrity incident',
    needsReason: true,
    confirm: 'KILL trade',
    phrase: 'KILL trade',
    blockedReason: null,
    busy: false,
  };
  it('opens with a reason and the exact phrase', () => expect(requestGate(ok)).toEqual({ ok: true }));
  it('a deployment block wins over everything', () => {
    expect(requestGate({ ...ok, blockedReason: 'ADMIN_OPERATOR_TOKEN is not set' })).toEqual({
      ok: false,
      why: 'ADMIN_OPERATOR_TOKEN is not set',
    });
  });
  it('refuses a short, padded-only or oversize reason', () => {
    expect(requestGate({ ...ok, reason: 'short' }).ok).toBe(false);
    expect(requestGate({ ...ok, reason: ' '.repeat(40) }).ok).toBe(false);
    expect(requestGate({ ...ok, reason: 'x'.repeat(501) }).ok).toBe(false);
  });
  it('refuses a near-miss phrase, including the wrong case and trailing space', () => {
    for (const confirm of ['kill trade', 'KILL trade ', 'KILL  trade', 'KILL pay', ''])
      expect(requestGate({ ...ok, confirm }).ok).toBe(false);
  });
  it('an unfreeze needs no reason but still needs the phrase', () => {
    const thaw = { ...ok, reason: '', needsReason: false, phrase: 'UNFREEZE LEDGER', confirm: 'UNFREEZE LEDGER' };
    expect(requestGate(thaw)).toEqual({ ok: true });
    expect(requestGate({ ...thaw, confirm: '' }).ok).toBe(false);
  });
  it('is shut while a step is in flight', () => expect(requestGate({ ...ok, busy: true }).ok).toBe(false));
});

describe('which button a founder may press', () => {
  it('the second founder can approve, with the phrase', () => expect(step()).toEqual({ ok: true }));
  it('the requester cannot approve their own request', () => expect(step({ userId: A }).ok).toBe(false));
  it('approve and run need the exact phrase for the request in the packet', () => {
    for (const s of ['approve', 'execute'] as const) {
      expect(step({ step: s, confirm: 'KILL pay' }).ok).toBe(false);
      expect(step({ step: s, confirm: '' }).ok).toBe(false);
    }
  });
  it('an expired approval cannot be approved or run, but can still be rejected or withdrawn', () => {
    const late = new Date('2026-10-17T03:10:00.000Z');
    expect(step({ now: late }).ok).toBe(false);
    expect(step({ step: 'execute', now: late }).ok).toBe(false);
    expect(step({ step: 'reject', now: late, confirm: '' })).toEqual({ ok: true });
    expect(step({ step: 'revoke', userId: A, now: late, confirm: '' })).toEqual({ ok: true });
  });
  it('rejecting and withdrawing never need the phrase and never hit a deployment block', () => {
    expect(step({ step: 'reject', confirm: '', blockedReason: 'unconfigured' })).toEqual({ ok: true });
    expect(step({ step: 'revoke', userId: A, confirm: '', blockedReason: 'unconfigured' })).toEqual({ ok: true });
  });
  it('only the requester withdraws and only the other founder rejects', () => {
    expect(step({ step: 'revoke' }).ok).toBe(false);
    expect(step({ step: 'reject', userId: A }).ok).toBe(false);
  });
  it('a deployment block stops approve and run', () => {
    expect(step({ blockedReason: 'unconfigured' }).ok).toBe(false);
    expect(step({ step: 'execute', blockedReason: 'unconfigured' }).ok).toBe(false);
  });
  it('nothing is pressable while a step is in flight', () => {
    for (const s of ['approve', 'reject', 'revoke', 'execute'] as const) expect(step({ step: s, busy: true }).ok).toBe(false);
  });
});

describe('short ids', () => {
  it('shortens long ids and names a missing one', () => {
    expect(shortId(A)).toBe('11111111…1111');
    expect(shortId('abc')).toBe('abc');
    expect(shortId(null)).toBe('nobody yet');
  });
});
