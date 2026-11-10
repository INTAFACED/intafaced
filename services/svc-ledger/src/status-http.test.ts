import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { RECONCILE_ACTOR, RECONCILE_MISMATCH_REASON, RECONCILE_UNPROVEN_REASON } from './ledger/reconcile-config.js';
import { freezeCause, registerLedgerStatusHttp } from './status-http.js';

describe('why the posting freeze is on (/health frozenCause)', () => {
  const frozen = (frozenReason: string, frozenBy: string) => ({ postingEnabled: false, frozenReason, frozenBy });

  it('sorts each freeze svc-ledger makes into its cause, and is null while posting is enabled', () => {
    expect(freezeCause({ postingEnabled: true, frozenReason: null, frozenBy: 'op-1' })).toBeNull();
    expect(freezeCause(frozen('operator halt for USDT recon', 'op-1'))).toBe('person');
    expect(freezeCause(frozen(RECONCILE_MISMATCH_REASON, RECONCILE_ACTOR))).toBe('mismatch');
    expect(freezeCause(frozen(RECONCILE_UNPROVEN_REASON, RECONCILE_ACTOR))).toBe('unfinished_proofs');
    expect(freezeCause(frozen('LEDGER_POSTING_ENABLED=false at startup', 'env:LEDGER_POSTING_ENABLED'))).toBe('startup_setting');
  });

  it('/health carries the cause beside the reason and actor', async () => {
    const app = Fastify();
    registerLedgerStatusHttp(app, { status: async () => frozen(RECONCILE_UNPROVEN_REASON, RECONCILE_ACTOR) }, 'svc-ledger');
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({
      ok: true,
      postingEnabled: false,
      frozenReason: RECONCILE_UNPROVEN_REASON,
      frozenBy: RECONCILE_ACTOR,
      frozenCause: 'unfinished_proofs',
    });
    await app.close();
  });
});
