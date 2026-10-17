import { describe, expect, it } from 'vitest';
import { BLOCKERS } from './blockers';
import {
  MATCHING_ACTIONS,
  checkMatchingRequest,
  matchingActionSpec,
  matchingEdgePath,
  matchingIdempotencyKey,
  matchingPayloadHash,
  matchingTargetId,
} from './matching-controls';

const MARKET = '11111111-2222-4333-8444-555555555555';

describe('blockers', () => {
  it('no longer names a route svc-edge now has (#4948)', () => {
    const keys = Object.keys(BLOCKERS);
    for (const gone of ['matching_not_routed', 'matching_health_not_routed', 'surveillance_not_routed']) expect(keys).not.toContain(gone);
  });
  it('keeps the adjudicate gap, which svc-edge refuses by design', () => {
    expect(BLOCKERS.surveillance_adjudicate_not_exposed.owner).toBe('svc-edge');
  });
});

describe('matching controls', () => {
  it('maps each desk action to the edge path, action type and target svc-edge checks', () => {
    const paths = MATCHING_ACTIONS.map((a) => matchingEdgePath(a, a.perMarket ? MARKET : null));
    expect(paths).toEqual([
      `/admin/trade-ops/matching/markets/${MARKET}/halt`,
      `/admin/trade-ops/matching/markets/${MARKET}/resume`,
      `/admin/trade-ops/matching/markets/${MARKET}/reduce-only`,
      `/admin/trade-ops/matching/markets/${MARKET}/reduce-only/off`,
      `/admin/trade-ops/matching/markets/${MARKET}/post-only`,
      `/admin/trade-ops/matching/markets/${MARKET}/post-only/off`,
      `/admin/trade-ops/matching/markets/${MARKET}/delist`,
      '/admin/trade-ops/matching/halt-all',
      '/admin/trade-ops/matching/resume-all',
    ]);
    const halt = matchingActionSpec('halt')!;
    expect(halt.actionType).toBe('matching.halt');
    expect(matchingTargetId(halt, MARKET)).toBe(`halt:${MARKET}`);
    expect(matchingTargetId(matchingActionSpec('halt_all')!, null)).toBe('halt_all');
    expect(matchingActionSpec('reduce_only_off')!.actionType).toBe('matching.reduce_only_resume');
  });
  it('hashes the payload the way svc-matching does (sha256 of { actionType, marketId })', () => {
    expect(matchingPayloadHash(matchingActionSpec('halt')!, 'm-1')).toBe(
      'sha256:dacc3af5283c2cd7b6113459bb586e4d97f1a5af58473beda1ca8b0c65225110',
    );
  });
  it('gives the same client request id for the same approval, so a replay returns the first result', () => {
    const halt = matchingActionSpec('halt')!;
    expect(matchingIdempotencyKey(halt, 'm-1', 'ap-1')).toBe(matchingIdempotencyKey(halt, 'm-1', 'ap-1'));
    expect(matchingIdempotencyKey(halt, 'm-1', 'ap-1')).not.toBe(matchingIdempotencyKey(halt, 'm-1', 'ap-2'));
  });
});

describe('checkMatchingRequest', () => {
  const run = { action: 'halt', step: 'run', marketId: MARKET, approvalId: 'approval-12345' };
  it('accepts a complete run, a propose without an approval id, and a venue-wide control', () => {
    expect(checkMatchingRequest(run).ok).toBe(true);
    expect(checkMatchingRequest({ action: 'halt', step: 'propose', marketId: MARKET }).ok).toBe(true);
    expect(checkMatchingRequest({ action: 'halt_all', step: 'run', approvalId: 'approval-12345' }).ok).toBe(true);
  });
  it('needs an approval id to run or read status: two operator names are not an approval', () => {
    expect(checkMatchingRequest({ ...run, approvalId: '' })).toMatchObject({ ok: false, code: 'trade_ops.approval_required' });
    expect(checkMatchingRequest({ ...run, step: 'status', approvalId: '' })).toMatchObject({
      ok: false,
      code: 'trade_ops.approval_required',
    });
  });
  it('needs a market for per-market controls and refuses one on venue-wide controls', () => {
    expect(checkMatchingRequest({ ...run, marketId: '' })).toMatchObject({ code: 'trade_ops.market_required' });
    expect(checkMatchingRequest({ ...run, action: 'halt_all' })).toMatchObject({ code: 'trade_ops.market_not_allowed' });
  });
  it('needs the symbol typed back for delist only', () => {
    const delist = { ...run, action: 'delist', symbol: 'AUD/USD' };
    expect(checkMatchingRequest({ ...delist, typedSymbol: 'AUD' })).toMatchObject({ ok: false, code: 'trade_ops.symbol_mismatch' });
    expect(checkMatchingRequest({ ...delist, typedSymbol: 'AUD/USD' }).ok).toBe(true);
    expect(checkMatchingRequest({ ...run, typedSymbol: '' }).ok).toBe(true);
  });
  it('refuses unknown actions and steps', () => {
    expect(checkMatchingRequest({ ...run, action: 'nuke' })).toMatchObject({ code: 'trade_ops.bad_action' });
    expect(checkMatchingRequest({ ...run, step: 'now' })).toMatchObject({ code: 'trade_ops.bad_step' });
  });
});

describe('approvals list', () => {
  it('is no longer a static blocker: identity has actionApproval.list', () => {
    expect(Object.keys(BLOCKERS)).not.toContain('approvals_list_missing');
  });
});
