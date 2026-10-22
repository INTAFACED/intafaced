import { describe, expect, it } from 'vitest';
import { moduleForApi, moduleForPage } from '@/lib/modules';
import { isSendId, readHoldAction, refusalWords } from './model';
import { parseControls, parseQueue } from './read';

const SEND = '3f0c1f3e-5a77-4d52-9a1e-0c9b6b1f2a10';

describe('hold requests', () => {
  it('reads each action in the shape the service takes and trims the text', () => {
    expect(
      readHoldAction({ action: 'hold', sendId: SEND, holdKey: 'console-hold-abc1', reason: ' risk ', infoRequest: ' a bill ' }),
    ).toEqual({
      action: 'hold',
      sendId: SEND,
      holdKey: 'console-hold-abc1',
      reason: 'risk',
      infoRequest: 'a bill',
    });
    expect(readHoldAction({ action: 'hold', sendId: SEND, holdKey: 'console-hold-abc1', reason: 'r' })).toEqual({
      action: 'hold',
      sendId: SEND,
      holdKey: 'console-hold-abc1',
      reason: 'r',
    });
    expect(readHoldAction({ action: 'requestInfo', sendId: SEND, infoRequest: 'proof' })?.action).toBe('requestInfo');
    expect(readHoldAction({ action: 'release', sendId: SEND })).toEqual({ action: 'release', sendId: SEND });
    expect(readHoldAction({ action: 'linkReference', sendId: SEND, reference: ' ref123 ' })).toEqual({
      action: 'linkReference',
      sendId: SEND,
      reference: 'ref123',
    });
  });
  it('refuses anything off-shape, extra keys included', () => {
    expect(readHoldAction(null)).toBeNull();
    expect(readHoldAction({ action: 'release', sendId: 'x' })).toBeNull();
    expect(readHoldAction({ action: 'release', sendId: SEND, operatorId: 'me' })).toBeNull();
    expect(readHoldAction({ action: 'hold', sendId: SEND, holdKey: 'short', reason: 'r' })).toBeNull();
    expect(readHoldAction({ action: 'hold', sendId: SEND, holdKey: 'console-hold-abc1', reason: ' ' })).toBeNull();
    expect(readHoldAction({ action: 'linkReference', sendId: SEND, reference: 'abc' })).toBeNull();
    expect(readHoldAction({ action: 'requestInfo', sendId: SEND, infoRequest: 'x'.repeat(1001) })).toBeNull();
    expect(readHoldAction({ action: 'delete', sendId: SEND })).toBeNull();
  });
  it('checks a send id for shape only', () => {
    expect(isSendId(SEND)).toBe(true);
    expect(isSendId('nope')).toBe(false);
    expect(isSendId(null)).toBe(false);
  });
  it('has words for the typed refusals and none for an unknown code', () => {
    for (const code of [
      'bank.transfer_settled',
      'bank.hold_conflict',
      'bank.release_same_operator',
      'bank.link_reference_conflict',
      'bank.proof_limits_unset',
    ]) {
      expect(refusalWords(code), code).toBeTruthy();
    }
    expect(refusalWords('x.y')).toBeNull();
    expect(refusalWords(null)).toBeNull();
  });
  it('sits under the bank ops gate', () => {
    expect(moduleForPage('/bank-ops/holds')).toBe('bank-ops');
    expect(moduleForApi('/api/bank-ops/holds')).toBe('bank-ops');
  });
});

describe('service answers', () => {
  const row = {
    id: 'h1',
    sendId: SEND,
    state: 'requested',
    reason: 'r',
    heldBy: 'op1',
    infoRequest: null,
    proof: null,
    releasedBy: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    send: {
      id: SEND,
      userId: 'u1',
      assetId: 'USDT',
      amount: '10',
      toCurrency: 'EUR',
      country: 'DE',
      deliveryMethod: 'bank',
      status: 'held',
    },
  };
  it('reads a queue and rejects a row with a missing field', () => {
    expect(parseQueue([row])?.[0]?.send.userId).toBe('u1');
    expect(parseQueue([])).toEqual([]);
    expect(parseQueue([{ ...row, heldBy: undefined }])).toBeNull();
    expect(parseQueue({})).toBeNull();
  });
  it('reads the controls and rejects an unknown state', () => {
    const ok = {
      payeeControls: { state: 'unset', blockedCount: 0 },
      exchangeAllowance: { state: 'published', windowDays: 30, exchangeCount: 2 },
      proofLimits: { state: 'unset', allowedTypes: [], maxBytes: null },
    };
    expect(parseControls(ok)?.exchangeAllowance.windowDays).toBe(30);
    expect(parseControls({ ...ok, payeeControls: { state: 'maybe', blockedCount: 0 } })).toBeNull();
  });
});
