import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context, IdentityOperationDecisionInput, IdentityOperationIntent } from '@intafaced/contracts';
import { FounderControls, parseFounderPair } from './founder-controls.js';
import { OperationIdentityDecisions } from './operation-identity-decisions.js';

const url = process.env.TEST_DATABASE_URL;
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationDirectory, name), 'utf8'));
const tokens = {
  secret: 'synthetic-operation-tests-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

describe.runIf(Boolean(url))('durable identity operation decisions', () => {
  let db: TestDatabase;
  let controls: FounderControls;
  let decisions: OperationIdentityDecisions;
  let founder: Context;
  let target: Context;

  async function seed(): Promise<Context> {
    const userId = randomUUID(),
      sessionId = randomUUID();
    await db.sql`INSERT INTO users (id,handle,email,password_hash,totp_secret,totp_enrolled_at) VALUES
      (${userId},${userId.replaceAll('-', '').slice(0, 20)},${`${userId}@example.test`},'synthetic-hash','synthetic-verified-factor',now())`;
    await db.sql`INSERT INTO sessions(id,user_id,refresh_hash,mfa,expires_at) VALUES
      (${sessionId},${userId},${`synthetic:${sessionId}`},true,now()+interval '1 day')`;
    const issued = await issueAccessToken(
      { userId, sessionId, scopes: ['identity:read', 'identity:write', 'ops:read', 'ops:write'], mfa: true },
      tokens,
    );
    return { principal: await verifyAccessToken(issued.token, tokens), service: null, region: 'DE', requestId: randomUUID() };
  }
  function intent(kind: 'order.place' | 'strategy.start' = 'order.place'): IdentityOperationIntent {
    return {
      operation: { service: 'svc-trade', kind, userId: target.principal!.userId },
      businessId: randomUUID(),
      payloadHash: 'sha256:' + 'a'.repeat(64),
      authority: {
        kind: 'credential',
        subject: { userId: target.principal!.userId, credential: { kind: 'session', sessionId: target.principal!.sid } },
      },
    };
  }
  const grant = (value: IdentityOperationIntent): IdentityOperationDecisionInput => ({ mode: 'grant', intent: value });
  const cancel = (value: IdentityOperationIntent): IdentityOperationDecisionInput => ({ mode: 'resolve_or_cancel', intent: value });
  const change = (action: 'restrict' | 'restore', expectedVersion: string) =>
    controls.change(founder, {
      requestId: randomUUID(),
      target: { area: 'identity', userId: target.principal!.userId },
      action,
      reason: 'Synthetic concurrency proof',
      expectedVersion,
    });

  beforeEach(async () => {
    if (!db) db = await createTestDatabase({ service: 'identity', url, migrations });
    await db.truncateAll();
    founder = await seed();
    const second = await seed();
    target = await seed();
    controls = new FounderControls(db.sql, parseFounderPair(founder.principal!.userId, second.principal!.userId));
    expect(await controls.bootstrap()).toBe(true);
    decisions = new OperationIdentityDecisions(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('commits one decision for concurrent retries and resolves it through a fresh connection', async () => {
    const input = intent();
    const results = await Promise.all([decisions.decide(grant(input), 'svc-trade'), decisions.decide(grant(input), 'svc-trade')]);
    expect(results[0]).toMatchObject({ status: 'granted', identityVersion: '0', intent: input });
    expect(results[1]).toEqual(results[0]);
    const restarted = postgres(db.url, { max: 1, connection: { search_path: 'identity,public' } });
    try {
      expect(await new OperationIdentityDecisions(restarted).decide(cancel(input), 'svc-trade')).toEqual(results[0]);
    } finally {
      await restarted.end();
    }
    expect(await db.sql`SELECT business_id FROM operation_identity_decisions`).toHaveLength(1);
  });

  it('cancellation tombstones refuse a delayed first grant and survive retry', async () => {
    const input = intent();
    const cancelled = await decisions.decide(cancel(input), 'svc-trade');
    expect(cancelled).toMatchObject({ status: 'cancelled', code: 'admission.cancelled' });
    expect(await decisions.decide(grant(input), 'svc-trade')).toEqual(cancelled);
    expect(await decisions.decide(cancel(input), 'svc-trade')).toEqual(cancelled);
  });

  it('binds the original immutable payload and rejects altered recovery', async () => {
    const input = intent();
    const original = await decisions.decide(grant(input), 'svc-trade');
    expect(await decisions.decide(grant({ ...input, payloadHash: 'sha256:' + 'b'.repeat(64) }), 'svc-trade')).toEqual({
      status: 'conflict',
      code: 'operation.conflict',
    });
    expect(await decisions.decide(grant(input), 'svc-trade')).toEqual(original);
    await expect(decisions.decide(grant(input), 'svc-pay')).rejects.toThrow('identity.operation_owner_denied');
  });

  it('preserves a prior grant after freeze while denying every fresh operation', async () => {
    const input = intent();
    const original = await decisions.decide(grant(input), 'svc-trade');
    expect((await change('restrict', '0')).outcome).toBe('changed');
    expect(await decisions.decide(cancel(input), 'svc-trade')).toEqual(original);
    expect(await decisions.decide(grant(input), 'svc-trade')).toEqual(original);
    expect(await decisions.decide(grant(intent()), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.account_frozen' });
  });

  it('restore does not renew revoked original credentials or cancelled intents', async () => {
    const input = intent();
    await change('restrict', '0');
    const denied = await decisions.decide(grant(input), 'svc-trade');
    await change('restore', '1');
    expect(await decisions.decide(grant(input), 'svc-trade')).toEqual(denied);
    expect(await decisions.decide(grant(intent()), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.credential_denied' });
  });

  it('locks and checks actual credential owner, revocation, expiry and subaccount', async () => {
    await db.sql`UPDATE sessions SET revoked=true WHERE id=${target.principal!.sid}`;
    expect(await decisions.decide(grant(intent()), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.credential_denied' });
    await db.sql`UPDATE sessions SET revoked=false,expires_at=now()-interval '1 second' WHERE id=${target.principal!.sid}`;
    expect(await decisions.decide(grant(intent()), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.credential_denied' });
    await db.sql`UPDATE sessions SET expires_at=now()+interval '1 day' WHERE id=${target.principal!.sid}`;
    const input = intent();
    if (input.authority.kind !== 'credential') throw new Error();
    input.authority.subject.subAccountId = randomUUID();
    expect(await decisions.decide(grant(input), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.sub_account_denied' });
    const foreign = intent();
    if (foreign.authority.kind !== 'credential') throw new Error();
    foreign.authority.subject.credential = { kind: 'session', sessionId: founder.principal!.sid };
    expect(await decisions.decide(grant(foreign), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.credential_denied' });
  });

  it('fresh delegated children recheck the original parent credential and actual owner', async () => {
    const parent = await decisions.decide(grant(intent('strategy.start')), 'svc-trade');
    if (parent.status !== 'granted') throw new Error();
    const child: IdentityOperationIntent = {
      ...intent(),
      operation: { service: 'svc-trade', kind: 'algo.child', userId: target.principal!.userId },
      authority: { kind: 'delegation', parentGrantId: parent.grantId },
    };
    expect(await decisions.decide(grant(child), 'svc-trade')).toMatchObject({ status: 'granted' });
    expect(
      await decisions.decide(
        grant({ ...child, businessId: randomUUID(), operation: { ...child.operation, userId: founder.principal!.userId } }),
        'svc-trade',
      ),
    ).toMatchObject({ status: 'cancelled', code: 'auth.credential_denied' });
    await change('restrict', '0');
    await change('restore', '1');
    expect(await decisions.decide(grant({ ...child, businessId: randomUUID() }), 'svc-trade')).toMatchObject({
      status: 'cancelled',
      code: 'auth.credential_denied',
    });
  });

  it('requires the actual API-key account binding for fresh admission and rechecks its revocation', async () => {
    const keyId = randomUUID(),
      subId = randomUUID(),
      otherSubId = randomUUID();
    const userId = target.principal!.userId;
    await db.sql`INSERT INTO sub_accounts(id,parent_user_id,label) VALUES (${subId},${userId},'Bound partition'), (${otherSubId},${userId},'Other partition')`;
    await db.sql`INSERT INTO api_keys(id,user_id,name,key_hash,key_prefix,scopes,account_id) VALUES
      (${keyId},${userId},'Synthetic bound key',${`synthetic:${keyId}`},'fixture',${['trade:write']},${subId})`;
    const keyed: IdentityOperationIntent = {
      ...intent(),
      authority: { kind: 'credential', subject: { userId, credential: { kind: 'api_key', apiKeyId: keyId } } },
    };
    expect(await decisions.decide(grant(keyed), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.sub_account_denied' });
    const wrong = {
      ...keyed,
      businessId: randomUUID(),
      authority: {
        kind: 'credential' as const,
        subject: { userId, credential: { kind: 'api_key' as const, apiKeyId: keyId }, subAccountId: otherSubId },
      },
    };
    expect(await decisions.decide(grant(wrong), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.sub_account_denied' });
    const bound = {
      ...wrong,
      businessId: randomUUID(),
      authority: { ...wrong.authority, subject: { ...wrong.authority.subject, subAccountId: subId } },
    };
    const admitted = await decisions.decide(grant(bound), 'svc-trade');
    expect(admitted).toMatchObject({ status: 'granted' });
    await db.sql`UPDATE sub_accounts SET revoked=true WHERE id=${subId}`;
    expect(await decisions.decide(grant({ ...bound, businessId: randomUUID() }), 'svc-trade')).toMatchObject({
      status: 'cancelled',
      code: 'auth.sub_account_denied',
    });
    expect(await decisions.decide(cancel(bound), 'svc-trade')).toEqual(admitted);
  });

  it('hosted merchant policy still requires the real active identity', async () => {
    const input: IdentityOperationIntent = {
      businessId: randomUUID(),
      payloadHash: 'sha256:' + 'a'.repeat(64),
      operation: { service: 'svc-pay', kind: 'payment.capture', userId: target.principal!.userId, merchantId: randomUUID() },
      authority: { kind: 'merchant_policy', merchantId: '' },
    };
    if (input.operation.service !== 'svc-pay' || input.authority.kind !== 'merchant_policy') throw new Error();
    input.authority.merchantId = input.operation.merchantId;
    expect(await decisions.decide(grant(input), 'svc-pay')).toMatchObject({ status: 'granted' });
    await change('restrict', '0');
    expect(await decisions.decide(grant({ ...input, businessId: randomUUID() }), 'svc-pay')).toMatchObject({
      status: 'cancelled',
      code: 'auth.account_frozen',
    });
  });

  function payfacIntent(actor: Context, explicit = false): IdentityOperationIntent {
    const actorMerchantId = randomUUID(),
      subjectMerchantId = randomUUID();
    return {
      businessId: randomUUID(),
      payloadHash: 'sha256:' + 'a'.repeat(64),
      operation: { service: 'svc-pay', kind: 'payment.create', userId: target.principal!.userId, merchantId: subjectMerchantId },
      authority: {
        kind: 'payfac_credential',
        subject: { userId: actor.principal!.userId, credential: { kind: 'session', sessionId: actor.principal!.sid } },
        area: 'payment',
        proof: explicit
          ? { kind: 'explicit_grant', actorMerchantId, subjectMerchantId, grantEventId: randomUUID(), grantSequence: '7' }
          : { kind: 'root_relation', actorMerchantId, subjectMerchantId },
      },
    };
  }

  it.each([false, true])('checks the original PayFac actor as well as the child owner (explicit grant: %s)', async (explicit) => {
    const actor = await seed();
    const input = payfacIntent(actor, explicit);
    const admitted = await decisions.decide(grant(input), 'svc-pay');
    expect(admitted).toMatchObject({ status: 'granted', intent: input });
    await controls.change(founder, {
      requestId: randomUUID(),
      target: { area: 'identity', userId: actor.principal!.userId },
      action: 'restrict',
      reason: 'Synthetic PayFac actor cutoff',
      expectedVersion: '0',
    });
    expect(await decisions.decide(grant({ ...input, businessId: randomUUID() }), 'svc-pay')).toMatchObject({
      status: 'cancelled',
      code: 'auth.account_frozen',
    });
    expect(await decisions.decide(cancel(input), 'svc-pay')).toEqual(admitted);
    const otherActor = await seed();
    await change('restrict', '0');
    expect(await decisions.decide(grant(payfacIntent(otherActor, explicit)), 'svc-pay')).toMatchObject({
      status: 'cancelled',
      code: 'auth.account_frozen',
    });
  });

  it('checks actual PayFac credential ownership, expiry and revocation instead of trusting its assertion', async () => {
    const actor = await seed();
    const input = payfacIntent(actor);
    if (input.authority.kind !== 'payfac_credential') throw new Error();
    const foreign = {
      ...input,
      authority: {
        ...input.authority,
        subject: {
          ...input.authority.subject,
          credential: { kind: 'session' as const, sessionId: target.principal!.sid },
        },
      },
    };
    expect(await decisions.decide(grant(foreign), 'svc-pay')).toMatchObject({ status: 'cancelled', code: 'auth.credential_denied' });
    await db.sql`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=${actor.principal!.sid}`;
    expect(await decisions.decide(grant({ ...input, businessId: randomUUID() }), 'svc-pay')).toMatchObject({
      status: 'cancelled',
      code: 'auth.credential_denied',
    });
    await db.sql`UPDATE sessions SET expires_at=now()+interval '1 day',revoked=true WHERE id=${actor.principal!.sid}`;
    expect(await decisions.decide(grant({ ...input, businessId: randomUUID() }), 'svc-pay')).toMatchObject({
      status: 'cancelled',
      code: 'auth.credential_denied',
    });
  });

  it('concurrent grant/cancellation resolves one immutable outcome, never a later upgrade', async () => {
    for (let n = 0; n < 8; n++) {
      const input = intent();
      const [first, second] = await Promise.all([
        decisions.decide(grant(input), 'svc-trade'),
        decisions.decide(cancel(input), 'svc-trade'),
      ]);
      expect(['granted', 'cancelled']).toContain(first.status);
      expect(second).toEqual(first);
      expect(await decisions.decide(grant(input), 'svc-trade')).toEqual(first);
    }
  });

  it('races freeze against fresh grants under one guard without issuing a post-freeze version', async () => {
    const input = intent();
    const [decision, frozen] = await Promise.all([decisions.decide(grant(input), 'svc-trade'), change('restrict', '0')]);
    expect(frozen.outcome).toBe('changed');
    if (decision.status === 'granted') expect(decision.identityVersion).toBe('0');
    else expect(decision).toMatchObject({ status: 'cancelled', code: 'auth.account_frozen' });
    expect(await decisions.decide(grant(intent()), 'svc-trade')).toMatchObject({ status: 'cancelled', code: 'auth.account_frozen' });
  });

  it('database forbids decision rewriting and deletion', async () => {
    const input = intent();
    await decisions.decide(grant(input), 'svc-trade');
    await expect(db.sql`UPDATE operation_identity_decisions SET decision=decision`).rejects.toThrow('immutable');
    await expect(db.sql`DELETE FROM operation_identity_decisions`).rejects.toThrow('immutable');
  });
});
