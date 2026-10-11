import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Context, IdentityOperationDecision, IdentityOperationIntent, IdentityOperationDecisionPort } from '@intafaced/contracts';
import { principalFor } from '../spot/testing.js';
import { canonicalPayload, TradingControls, type LiveTradingOperatorPort } from './trading-controls.js';

const user = 'a1111111-1111-4111-8111-111111111111';
const founder = 'b1111111-1111-4111-8111-111111111111';
const other = 'c1111111-1111-4111-8111-111111111111';
const actor = (id = founder): Context & { principal: ReturnType<typeof principalFor> } => ({
  principal: { ...principalFor(id), mfa: true },
  region: 'XX',
  service: null,
  requestId: randomUUID(),
});
const command = (version = '0', action: 'restrict' | 'restore' = 'restrict') => ({
  requestId: randomUUID(),
  target: { area: 'trading' as const, userId: user },
  action,
  reason: 'Operator investigation',
  expectedVersion: version,
});
class Identity implements IdentityOperationDecisionPort {
  readonly rows = new Map<string, IdentityOperationDecision>();
  fail = false;
  onGrant?: () => Promise<void>;
  async decide({
    mode,
    intent,
  }: {
    mode: 'grant' | 'resolve_or_cancel';
    intent: IdentityOperationIntent;
  }): Promise<IdentityOperationDecision> {
    if (this.fail) return { status: 'unavailable', code: 'authority.unavailable' };
    const key = intent.operation.userId + ':' + intent.businessId;
    const old = this.rows.get(key);
    if (old) return old;
    const decision: IdentityOperationDecision =
      mode === 'grant'
        ? { intent, status: 'granted', grantId: randomUUID(), identityVersion: '0', decidedAt: new Date().toISOString() }
        : { intent, status: 'cancelled', code: 'admission.cancelled', decidedAt: new Date().toISOString() };
    this.rows.set(key, decision);
    if (mode === 'grant') await this.onGrant?.();
    return decision;
  }
}

describe('Owned trading restrictions and identity decision handshake (real PostgreSQL)', () => {
  let db: TestDatabase;
  let identity: Identity;
  let allowed: boolean;
  let controls: TradingControls;
  const operators: LiveTradingOperatorPort = { check: async () => (allowed ? 'enabled' : 'denied') };
  beforeAll(async () => {
    db = await createTestDatabase({
      service: 'trade',
      migrations: [readFileSync(new URL('../../drizzle/0048_account_controls.sql', import.meta.url), 'utf8')],
    });
  }, 30_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE trade.account_restrictions, trade.account_control_history, trade.account_control_requests, trade.operation_intents`;
    allowed = true;
    identity = new Identity();
    controls = new TradingControls(db.sql, operators, identity);
  });
  it('either founder independently changes and restores, version-conflicts and noops are auditable', async () => {
    expect(await controls.change(actor(), command())).toMatchObject({ outcome: 'changed', after: { version: '1', restricted: true } });
    expect(await controls.change(actor(other), command('1'))).toMatchObject({ outcome: 'noop', after: { version: '1' } });
    expect(await controls.change(actor(other), command())).toMatchObject({ outcome: 'conflict' });
    expect(await controls.change(actor(other), command('1', 'restore'))).toMatchObject({
      outcome: 'changed',
      after: { version: '2', restricted: false },
    });
    expect(await controls.history(actor(), { target: command().target, limit: 10 })).toHaveLength(4);
  });
  it('replays original only after live reauthentication; actor/reason/version changes conflict', async () => {
    const input = command();
    const first = await controls.change(actor(), input);
    expect(
      await controls.change(actor(), {
        ...input,
        requestId: input.requestId.toUpperCase(),
        target: { ...input.target, userId: user.toUpperCase() },
      }),
    ).toEqual(first);
    expect(await controls.change(actor(other), input)).toMatchObject({ outcome: 'refused', code: 'request.conflict' });
    expect(await controls.change(actor(), { ...input, reason: 'Other explanation' })).toMatchObject({
      outcome: 'refused',
      code: 'request.conflict',
    });
    allowed = false;
    expect(await controls.change(actor(), input)).toMatchObject({ outcome: 'refused', code: 'operator.denied', current: null });
    await expect(controls.history(actor(), { target: input.target, limit: 1 })).rejects.toMatchObject({ code: 'operator.denied' });
  });
  it('rejects actor injection and other service targets, never leaks state to non-MFA callers', async () => {
    await expect(controls.change(actor(), { ...command(), actorUserId: other } as never)).rejects.toThrow();
    await expect(controls.change(actor(), { ...command(), target: { area: 'identity', userId: user } })).rejects.toThrow();
    expect(await controls.change({ ...actor(), principal: principalFor(founder) }, command())).toMatchObject({
      code: 'mfa.required',
      current: null,
    });
    const subaccountActor = actor();
    subaccountActor.principal = { ...subaccountActor.principal, sub_account: other };
    expect(await controls.change(subaccountActor, command())).toMatchObject({ code: 'operator.denied', current: null });
    await expect(controls.getState(subaccountActor, { target: command().target })).rejects.toMatchObject({ code: 'operator.denied' });
  });
  it('persists immutable original payload and recovery after restriction; altered retry refuses', async () => {
    const original = { qty: '1', price: '2' };
    const admission = await controls.admit(principalFor(user), 'order.place', 'order:1', original);
    await controls.change(actor(), command());
    expect(await controls.admit(principalFor(user), 'order.place', 'order:1', original)).toEqual(admission);
    expect(await controls.recover(user, 'order:1')).toMatchObject({ payload: original, admission });
    await expect(controls.admit(principalFor(user), 'order.place', 'order:1', { qty: '2', price: '2' })).rejects.toMatchObject({
      code: 'operation.conflict',
    });
    await expect(controls.admit(principalFor(user), 'order.place', 'order:2', original)).rejects.toMatchObject({
      code: 'trade.account_restricted',
    });
    await expect(db.sql`UPDATE trade.operation_intents SET payload = '{}' WHERE business_id = 'order:1'`).rejects.toMatchObject({
      code: '23514',
    });
    await expect(db.sql`DELETE FROM trade.account_control_history`).rejects.toMatchObject({ code: '23514' });
  });
  it('keeps local guard while grant is in flight: restriction waits then preserves the granted owner admission', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    identity.onGrant = async () => {
      entered();
      await blocked;
    };
    const admitted = controls.admit(principalFor(user), 'order.place', 'racing', { qty: '1' });
    await started;
    let restrictionFinished = false;
    const restriction = controls.change(actor(), command()).then((result) => {
      restrictionFinished = true;
      return result;
    });
    await db.sql`SELECT 1`;
    expect(restrictionFinished).toBe(false);
    release();
    expect(await admitted).toMatchObject({ status: 'committed' });
    expect(await restriction).toMatchObject({ outcome: 'changed' });
    expect(await controls.recover(user, 'racing')).not.toBeNull();
  });
  it('drains a crash after remote grant/local rollback and materializes the original admission before restriction', async () => {
    identity.onGrant = async () => {
      throw new Error('injected lost response after identity grant');
    };
    await expect(controls.admit(principalFor(user), 'order.place', 'crashed', { qty: '1' })).rejects.toMatchObject({
      code: 'authority.unavailable',
    });
    const [marked] = await db.sql`SELECT identity_requested, admission FROM trade.operation_intents WHERE business_id = 'crashed'`;
    expect(marked).toMatchObject({ identity_requested: true, admission: null });
    expect(await controls.change(actor(), command())).toMatchObject({ outcome: 'changed' });
    expect(await controls.recover(user, 'crashed')).toMatchObject({ payload: { qty: '1' } });
  });
  it('commits terminal denial before throwing and never requests a new grant after restart', async () => {
    let calls = 0;
    const rejecting: IdentityOperationDecisionPort = {
      decide: async ({ intent }) => {
        calls++;
        return { status: 'cancelled', intent, code: 'auth.credential_denied', decidedAt: new Date().toISOString() };
      },
    };
    const first = new TradingControls(db.sql, operators, rejecting);
    await expect(first.admit(principalFor(user), 'order.place', 'denied', { qty: '1' })).rejects.toMatchObject({
      code: 'auth.credential_denied',
    });
    const [stored] = await db.sql`SELECT decision, admission FROM trade.operation_intents WHERE business_id = 'denied'`;
    expect(stored).toMatchObject({ decision: { status: 'cancelled', code: 'auth.credential_denied' }, admission: null });
    const restarted = new TradingControls(db.sql, operators, {
      decide: async (input) => {
        calls++;
        return identity.decide(input);
      },
    });
    await expect(restarted.admit(principalFor(user), 'order.place', 'denied', { qty: '1' })).rejects.toMatchObject({
      code: 'auth.credential_denied',
    });
    expect(calls).toBe(1);
    expect(await restarted.resolve(user, 'denied')).toBeNull();
    const [retried] = await db.sql`SELECT decision, admission FROM trade.operation_intents WHERE business_id = 'denied'`;
    expect(retried).toEqual(stored);
    await expect(db.sql`UPDATE trade.operation_intents SET decision = '{}'::jsonb WHERE business_id = 'denied'`).rejects.toMatchObject({
      code: '23514',
    });
  });
  it('cancels every uncertain marked intent before restriction; identity outage refuses without pretending restriction committed', async () => {
    identity.fail = true;
    for (const businessId of ['pending-a', 'pending-b'])
      await expect(controls.admit(principalFor(user), 'order.place', businessId, { qty: '1' })).rejects.toThrow();
    expect(await controls.change(actor(), command())).toMatchObject({
      outcome: 'refused',
      code: 'authority.unavailable',
      current: { restricted: false },
    });
    identity.fail = false;
    expect(await controls.change(actor(), command())).toMatchObject({ outcome: 'changed' });
    const rows = await db.sql`SELECT decision->>'status' AS status FROM trade.operation_intents ORDER BY business_id`;
    expect(rows.map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
    await expect(controls.admit(principalFor(user), 'order.place', 'pending-a', { qty: '1' })).rejects.toMatchObject({
      code: 'trade.account_restricted',
    });
  });
  it.each(['algo.child', 'copy.mirror'] as const)(
    'parent grant does not admit fresh %s after restriction; old parents have no provenance',
    async (kind) => {
      const parent = await controls.admit(principalFor(user), 'strategy.start', 'strategy:1', { schedule: 'immutable' });
      await expect(
        controls.admit(principalFor(user), kind, 'old-child', {}, { parentBusinessId: 'missing', parentGrantId: parent.admissionId }),
      ).rejects.toMatchObject({ code: 'auth.credential_denied' });
      expect(
        await controls.admit(
          principalFor(user),
          kind,
          'child:1',
          {},
          { parentBusinessId: 'strategy:1', parentGrantId: parent.admissionId },
        ),
      ).toMatchObject({ status: 'committed' });
      await controls.change(actor(), command());
      await expect(
        controls.admit(principalFor(user), kind, 'child:2', {}, { parentBusinessId: 'strategy:1', parentGrantId: parent.admissionId }),
      ).rejects.toMatchObject({ code: 'trade.account_restricted' });
    },
  );
  it('no authority configuration refuses fresh exposure and controls, never creates a positive admission', async () => {
    const disabled = new TradingControls(db.sql, null, null);
    expect(await disabled.change(actor(), command())).toMatchObject({ outcome: 'refused', code: 'authority.unavailable', current: null });
    await expect(disabled.admit(principalFor(user), 'order.place', 'new', {})).rejects.toMatchObject({ code: 'authority.unavailable' });
    expect(await canonicalPayload({ b: '2', a: '1' })).toEqual('{"a":"1","b":"2"}');
  });
  it('binds verified requested subaccount and actual API key reference, without changing principal claims', async () => {
    const key = 'd1111111-1111-4111-8111-111111111111';
    const sub = 'e1111111-1111-4111-8111-111111111111';
    const principal = { ...principalFor(user), kid: key };
    await controls.admit(principal, 'order.place', 'key-order', {}, undefined, sub);
    expect([...identity.rows.values()][0]).toMatchObject({
      intent: {
        authority: {
          kind: 'credential',
          subject: {
            userId: user,
            credential: { kind: 'api_key', apiKeyId: key },
            subAccountId: sub,
          },
        },
      },
    });
    expect(principal).not.toHaveProperty('sub_account');
    await expect(
      controls.admit({ ...principal, sub_account: other }, 'order.place', 'different-sub', {}, undefined, sub),
    ).rejects.toMatchObject({ code: 'auth.credential_denied' });
  });
});
