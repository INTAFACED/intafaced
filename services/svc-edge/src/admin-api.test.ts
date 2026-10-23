import { describe, expect, it, vi } from 'vitest';
import { AuthError, issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { actionApprovalConsumeInputSchema, actionApprovalSchema } from '@intafaced/contracts';
import { createAdminApi, type LedgerOperatorCall } from './admin-api.js';
import { stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import { KillSwitchState } from './kill-switch.js';

// These suites read the live process env for the sanctions-screening posture. An
// unset APP_ENV is production-like and refuses by design, so they declare the test env.
vi.stubEnv('APP_ENV', 'test');

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';
const SESSION = '22222222-2222-4222-8222-222222222222';

function toggle(
  overrides: {
    module?: string;
    disabled?: boolean;
    reason?: string;
    confirmOperatorId?: string | null;
    approvalId?: string;
    operationId?: string;
  } = {},
) {
  return {
    module: 'trade',
    disabled: true,
    reason: 'stale prices on the book',
    confirmOperatorId: CONFIRM,
    approvalId: 'appr-1',
    operationId: 'op-1',
    ...overrides,
  };
}

async function tokenWith(scopes: string[], mfa: boolean): Promise<string> {
  const { token } = await issueAccessToken({ userId: OPERATOR, sessionId: SESSION, scopes, tier: 'institutional', mfa }, tokens);
  return `Bearer ${token}`;
}

function api(ledger: LedgerOperatorCall | null = null) {
  const state = new KillSwitchState();
  return {
    state,
    admin: createAdminApi(state, { tokens, ledger, approvals: stubApprovalConsumer('44444444-4444-4444-8444-444444444444') }),
  };
}

describe('who may reach the control plane', () => {
  it('refuses a caller with no token', async () => {
    await expect(api().admin.authenticate(undefined)).rejects.toBeInstanceOf(AuthError);
  });

  /**
   * The property that matters most here: a NORMAL user session must not be able
   * to switch the exchange off. `defaultScopes()` in svc-identity issues exactly
   * this list, and no path anywhere adds `admin:write` to it.
   */
  it('refuses an ordinary user session, however valid', async () => {
    const header = await tokenWith(['identity:read', 'identity:write', 'trade:read', 'trade:write', 'ledger:read'], true);
    await expect(api().admin.authenticate(header)).rejects.toMatchObject({ code: 'scope.denied' });
  });

  it('refuses an operator who has not passed a second factor', async () => {
    const header = await tokenWith(['admin:write'], false);
    await expect(api().admin.authenticate(header)).rejects.toMatchObject({ code: 'mfa.required' });
  });

  it('accepts an operator with admin:write and 2FA', async () => {
    const header = await tokenWith(['admin:write'], true);
    await expect(api().admin.authenticate(header)).resolves.toMatchObject({ userId: OPERATOR });
  });

  it('refuses a token signed with another key', async () => {
    const { token } = await issueAccessToken(
      { userId: OPERATOR, sessionId: SESSION, scopes: ['admin:write'], mfa: true },
      { ...tokens, secret: 'a-completely-different-secret-that-is-long-enough' },
    );
    await expect(api().admin.authenticate(`Bearer ${token}`)).rejects.toBeInstanceOf(AuthError);
  });
});

/**
 * Halting one market and halting ALL value movement are different authorities,
 * and the whole point of separating them is that holding the smaller one must
 * not get you the larger.
 */
describe('the treasury authority is not the module authority', () => {
  it('refuses admin:write on the ledger freeze', async () => {
    const header = await tokenWith(['admin:write'], true);
    await expect(api().admin.authenticateTreasury(header)).rejects.toMatchObject({ code: 'scope.denied' });
  });

  it('accepts admin:treasury on the ledger freeze', async () => {
    const header = await tokenWith(['admin:treasury'], true);
    await expect(api().admin.authenticateTreasury(header)).resolves.toMatchObject({ userId: OPERATOR });
  });

  /**
   * `admin:treasury` is in `INTERACTIVE_ONLY_SCOPES`, so `requireScope` enforces
   * the second factor itself. Asserted here rather than assumed, because the
   * whole guard rests on that list still containing it.
   */
  it('refuses admin:treasury without a second factor', async () => {
    const header = await tokenWith(['admin:treasury'], false);
    await expect(api().admin.authenticateTreasury(header)).rejects.toMatchObject({ code: 'mfa.required' });
  });

  it('takes admin:read with a second factor for the ledger lookups only, and refuses it without one', async () => {
    await expect(api().admin.authenticateLookup(await tokenWith(['admin:read'], true))).resolves.toMatchObject({ userId: OPERATOR });
    await expect(api().admin.authenticateLookup(await tokenWith(['admin:read'], false))).rejects.toMatchObject({ code: 'mfa.required' });
    await expect(api().admin.authenticateLookup(await tokenWith(['market:ops'], true))).rejects.toMatchObject({ code: 'scope.denied' });
    await expect(api().admin.authenticateTreasury(await tokenWith(['admin:read'], true))).rejects.toMatchObject({ code: 'scope.denied' });
  });

  it('does not let admin:treasury alone halt a module — the reverse is also true', async () => {
    const header = await tokenWith(['admin:treasury'], true);
    await expect(api().admin.authenticate(header)).rejects.toMatchObject({ code: 'scope.denied' });
  });
});

describe('control-plane honesty surface', () => {
  it('names ws as outside the door so status cannot invent a green live socket halt', () => {
    const { admin } = api();
    const h = admin.honesty();
    expect(h.outsideTheDoor.ws).toMatch(/not through this edge|socket\.ws-behind/i);
    expect(h.enforceableModules).not.toContain('ws');
    expect(h.enforceableModules).toContain('trade');
    expect(h.killState.multiReplicaShared).toBe(false);
  });

  /**
   * A2 residual (wave 8): `edge.gateway` is still NOT_ENFORCED. Status must say
   * the live kill is the operator surface, not the flag — otherwise a console
   * that only flips registry flags invents a green "gateway off" while the
   * proxy still serves.
   */
  it('names edge.gateway as unenforced and points at the operator kill surface', () => {
    const { admin } = api();
    const h = admin.honesty();
    expect(h.liveKillControl).toBe('operator-kill-switch');
    expect(h.flagEdgeGateway.key).toBe('edge.gateway');
    expect(h.flagEdgeGateway.enforced).toBe(false);
    expect(h.flagEdgeGateway.note).toMatch(/NOT_ENFORCED|does not stop the proxy/i);
    expect(h.flagEdgeGateway.note).toMatch(/kill-switches|operator/i);
    expect(h.flagEdgeGateway.note).toMatch(/confirmOperatorId/i);
    expect(h.killMutateDualControl).toBe(true);
  });
});

describe('applying a toggle', () => {
  const operator = { userId: OPERATOR } as never;

  it('switches a module off and reports the new state', async () => {
    const { state, admin } = api();
    const result = await admin.apply(toggle(), operator);

    expect(result.disabledModules).toEqual(['trade']);
    expect(result.changed).toBe(true);
    expect(result.confirmOperatorId).toBe(CONFIRM);
    expect(state.isKilled('trade')).toBe(true);
  });

  it('records who did it, because "somebody" is not an audit trail', async () => {
    const { state, admin } = api();
    await admin.apply(toggle(), operator);
    expect(state.reasonFor('trade')).toContain(OPERATOR);
    expect(state.reasonFor('trade')).toContain(CONFIRM);
  });

  it('refuses an unknown module rather than inventing one', async () => {
    const { admin } = api();
    await expect(admin.apply(toggle({ module: 'not-a-module', reason: 'a good enough reason' }), operator)).rejects.toThrow();
  });

  it('refuses a throwaway reason — friction is proportional to blast radius', async () => {
    const { admin } = api();
    await expect(admin.apply(toggle({ reason: 'oops' }), operator)).rejects.toThrow();
  });

  it('is idempotent, and says so, so a double-click is not a second incident', async () => {
    const { admin } = api();
    await admin.apply(toggle(), operator);
    const again = await admin.apply(toggle(), operator);
    expect(again.changed).toBe(false);
    expect(again.disabledModules).toEqual(['trade']);
  });

  it('refuses a halt or resume unless the consumed approver is present and distinct from the operator', async () => {
    const otherRequester = '55555555-5555-4555-8555-555555555555';
    const consumed = (approverId: string | null, requesterId = otherRequester): ActionApprovalConsumer => ({
      async consume(input) {
        const parsed = actionApprovalConsumeInputSchema.parse(input);
        return actionApprovalSchema.parse({
          ...parsed,
          actionType: parsed.targetId,
          requesterId,
          approverId,
          policyVersion: 'v1',
          createdAt: '2026-09-09T12:00:00.000Z',
          expiresAt: '2026-09-09T12:10:00.000Z',
          status: 'CONSUMED',
        });
      },
    });
    const withApprover = (approverId: string | null, requesterId?: string) => {
      const state = new KillSwitchState();
      return { state, admin: createAdminApi(state, { tokens, ledger: null, approvals: consumed(approverId, requesterId) }) };
    };

    const same = withApprover(OPERATOR, CONFIRM);
    await expect(same.admin.apply(toggle(), operator)).rejects.toMatchObject({ name: 'DualControlError', code: 'missing_operator' });
    expect(same.state.isKilled('trade')).toBe(false);
    expect(same.admin.read().audit).toHaveLength(0);

    const missing = withApprover(null, CONFIRM);
    await expect(missing.admin.apply(toggle({ module: 'pay' }), operator)).rejects.toMatchObject({ code: 'missing_operator' });
    expect(missing.state.isKilled('pay')).toBe(false);

    const blank = withApprover('   ', CONFIRM);
    await expect(blank.admin.apply(toggle({ module: 'identity' }), operator)).rejects.toMatchObject({ code: 'missing_operator' });
    expect(blank.state.isKilled('identity')).toBe(false);

    const state = new KillSwitchState();
    const distinct = createAdminApi(state, { tokens, ledger: null, approvals: consumed(CONFIRM) });
    const halted = await distinct.apply(toggle(), operator);
    expect(halted.confirmOperatorId).toBe(CONFIRM);
    expect(halted.changed).toBe(true);
    expect(state.isKilled('trade')).toBe(true);

    const oneOperatorResume = createAdminApi(state, { tokens, ledger: null, approvals: consumed(OPERATOR, CONFIRM) });
    await expect(
      oneOperatorResume.apply(toggle({ disabled: false, reason: 'feed recovered, resuming the market' }), operator),
    ).rejects.toMatchObject({ code: 'missing_operator' });
    expect(state.isKilled('trade')).toBe(true);

    const resumed = await distinct.apply(toggle({ disabled: false, reason: 'feed recovered, resuming the market' }), operator);
    expect(resumed.confirmOperatorId).toBe(CONFIRM);
    expect(resumed.changed).toBe(true);
    expect(state.isKilled('trade')).toBe(false);
  });

  it('refuses missing approval ids — a typed-in second name is not enough', async () => {
    const { state, admin } = api();
    await expect(admin.apply(toggle({ approvalId: '', operationId: '' }), operator)).rejects.toThrow(/typed-in second name/);
    await expect(admin.apply({ module: 'trade', disabled: true, reason: 'stale prices on the book' }, operator)).rejects.toThrow(
      /typed-in second name/,
    );
    expect(state.isKilled('trade')).toBe(false);
  });

  it('reports whether the edge was given a ledger URL without pretending freeze was read', () => {
    expect(api(null).admin.ledgerConfigured()).toBe(false);
    const call = vi.fn<LedgerOperatorCall>();
    expect(api(call).admin.ledgerConfigured()).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
});

/**
 * §14.6 deliverable: who, when, what, and THE PRIOR STATE. The last one is what
 * turns a list of events into a timeline somebody can reconstruct.
 */
describe('the audit trail', () => {
  const operator = { userId: OPERATOR } as never;

  it('carries who, when, what, why and what it was before', async () => {
    const { admin } = api();
    await admin.apply(toggle({ reason: 'book quoting stale prices' }), operator);

    const [entry] = admin.read().audit;
    expect(entry).toMatchObject({
      module: 'trade',
      actor: OPERATOR,
      confirmOperatorId: CONFIRM,
      reason: 'book quoting stale prices',
      previous: false,
      next: true,
      changed: true,
    });
    expect(Date.parse(entry!.at)).not.toBeNaN();
  });

  it('is newest-first, so the console opens on the last thing that happened', async () => {
    const { admin } = api();
    await admin.apply(toggle({ reason: 'book quoting stale prices' }), operator);
    await admin.apply(toggle({ module: 'pay', reason: 'rail partner outage, stop taking payments' }), operator);

    expect(admin.read().audit.map((e) => e.module)).toEqual(['pay', 'trade']);
  });

  /**
   * A re-halt of an already-halted module records `changed: false`. Without it,
   * an incident review cannot tell a second operator acting on stale
   * information from the first operator's action arriving twice.
   */
  it('records a no-op flip rather than dropping it', async () => {
    const { admin } = api();
    await admin.apply(toggle({ reason: 'book quoting stale prices' }), operator);
    await admin.apply(toggle({ reason: 'confirming the halt from the desk' }), operator);

    const audit = admin.read().audit;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ previous: true, next: true, changed: false });
  });

  it('records the resume too — an incident ends as well as starts', async () => {
    const { admin } = api();
    await admin.apply(toggle({ reason: 'book quoting stale prices' }), operator);
    await admin.apply(toggle({ disabled: false, reason: 'feed recovered, resuming the market' }), operator);

    expect(admin.read().audit[0]).toMatchObject({ previous: true, next: false, changed: true });
  });

  it('keeps the record even when the switch was never actually moved', async () => {
    // A refused toggle must not be silently absent from the trail. This one is
    // rejected by the schema before `set`, so nothing is recorded AND nothing is
    // switched — the two stay consistent, which is the invariant that matters.
    const { admin } = api();
    await expect(admin.apply(toggle({ reason: 'no' }), operator)).rejects.toThrow();
    expect(admin.read().audit).toHaveLength(0);
    expect(admin.read().disabledModules).toEqual([]);
  });

  it('is bounded, because an authenticated endpoint feeding an unbounded array is a leak', async () => {
    const { admin } = api();
    for (let i = 0; i < KillSwitchState.AUDIT_LIMIT + 20; i += 1) {
      await admin.apply(toggle({ disabled: i % 2 === 0, reason: `load test iteration number ${i}` }), operator);
    }
    expect(admin.read().audit).toHaveLength(KillSwitchState.AUDIT_LIMIT);
  });
});

describe('ops honesty residual on the admin door', () => {
  it('surfaces network unset ≠ clear and invent freeze refuse', () => {
    const { admin } = api();
    const ops = admin.opsHonesty();
    expect(ops.network.signal.declaration).toBe('unset');
    expect(ops.network.signal.partnerConfigured).toBe(false);
    expect(ops.freeze.soleKey).toBe('ledger.posting');
    expect(ops.freeze.inventProbes['trade freeze'].ok).toBe(false);
    expect(ops.freeze.inventProbes['ledger.posting'].ok).toBe(true);
    expect(ops.analytics.surface.mayLabelLive).toBe(false);
  });

  it('refuses partner_cleared without a screening partner and keeps the case', () => {
    const { admin } = api();
    admin.openComplianceCase({
      id: 'hit-1',
      kind: 'screening_hit',
      subjectId: 'u1',
      openedAt: '2026-08-09T00:00:00.000Z',
    });
    const r = admin.disposeComplianceCase('hit-1', { status: 'partner_cleared', partnerRef: 'slot' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('refuse.partner_absent');
    expect(admin.complianceQueueSnapshot().items.map((i) => i.id)).toEqual(['hit-1']);
  });

  it('probeWarehouse with injected SQL reading stamps lagSource=probed', async () => {
    const prev = process.env.ANALYTICS_REPLICA_LEDGER_URL;
    process.env.ANALYTICS_REPLICA_LEDGER_URL = 'postgres://analytics_ro:x@replica:5432/ledger';
    try {
      const state = new KillSwitchState();
      const admin = createAdminApi(state, {
        tokens,
        ledger: null,
        warehouseLagProbe: ({ nowMs }) => ({ lagSeconds: 4, measuredAt: nowMs }),
      });
      const door = await admin.probeWarehouse();
      expect(door.lagSource).toBe('probed');
      expect(door.lagSeconds).toBe(4);
      expect(typeof door.lagMeasuredAt).toBe('number');
      expect(door.replicaConfigured).toBe(true);
      // No fixture facts on the door — empty, never invented volume.
      expect(door.surfaceStatus).toBe('empty');
      expect(door.mayLabelLive).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ANALYTICS_REPLICA_LEDGER_URL;
      else process.env.ANALYTICS_REPLICA_LEDGER_URL = prev;
    }
  });

  it('probeWarehouse with no replica URL stays unconfigured — no sockets', async () => {
    const door = await api().admin.probeWarehouse();
    expect(door.replicaConfigured).toBe(false);
    expect(door.lagSource).toBe('unknown');
    expect(door.mayLabelLive).toBe(false);
    expect(door.surfaceStatus).not.toBe('ok');
  });
});

describe('reaching the ledger freeze', () => {
  it('tells the console it is unreachable rather than reporting success', async () => {
    const res = await api(null).admin.setFreeze(true, { reason: 'reconciliation mismatch on BTC' }, 'Bearer x');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'edge.ledger_unreachable' });
  });

  it('forwards the operator OWN token, so svc-ledger writes the actor itself', async () => {
    const call = vi.fn<LedgerOperatorCall>().mockResolvedValue({ status: 200, body: { frozen: true } });
    await api(call).admin.setFreeze(
      true,
      { reason: 'reconciliation mismatch on BTC', approvalId: 'appr-1', operationId: 'op-1' },
      'Bearer operator-token',
    );

    expect(call).toHaveBeenCalledWith('/operator/freeze', 'POST', 'Bearer operator-token', {
      reason: 'reconciliation mismatch on BTC',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
  });

  it('refuses an unexplained freeze before it leaves the edge', async () => {
    const call = vi.fn<LedgerOperatorCall>().mockResolvedValue({ status: 200, body: {} });
    await expect(api(call).admin.setFreeze(true, { reason: 'x' }, 'Bearer t')).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses freeze without approval ids before it leaves the edge', async () => {
    const call = vi.fn<LedgerOperatorCall>().mockResolvedValue({ status: 200, body: {} });
    await expect(api(call).admin.setFreeze(true, { reason: 'reconciliation mismatch on BTC' }, 'Bearer t')).rejects.toThrow(
      /typed-in second name/,
    );
    expect(call).not.toHaveBeenCalled();
  });

  /**
   * A thaw carries no reason — "why it is frozen" is meaningless once it is not,
   * and `writeFreeze` clears the column for that argument. So requiring one here
   * would be friction with nothing behind it.
   */
  it('thaws without a reason but still forwards approval ids', async () => {
    const call = vi.fn<LedgerOperatorCall>().mockResolvedValue({ status: 200, body: { frozen: false } });
    await api(call).admin.setFreeze(false, { approvalId: 'appr-1', operationId: 'op-1' }, 'Bearer t');
    expect(call).toHaveBeenCalledWith('/operator/unfreeze', 'POST', 'Bearer t', {
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
  });

  it('passes svc-ledger failures through instead of turning them into a success', async () => {
    const call = vi.fn<LedgerOperatorCall>().mockResolvedValue({ status: 502, body: { code: 'edge.ledger_unavailable' } });
    const res = await api(call).admin.setFreeze(
      true,
      { reason: 'reconciliation mismatch on BTC', approvalId: 'appr-1', operationId: 'op-1' },
      'Bearer t',
    );
    expect(res.status).toBe(502);
  });
});
