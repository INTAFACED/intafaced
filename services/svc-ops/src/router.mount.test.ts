import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  OPS_CUSTODY_CHAIN_UNWIRED,
  OPS_CUSTODY_FREEZE_UNSET,
  OPS_CUSTODY_FROZEN,
  OPS_CUSTODY_KEYS_FORBIDDEN,
  OPS_CUSTODY_WRAP_UNSET,
  OPS_FUNDRAISING_CHAIN_UNWIRED,
  OPS_PAYROLL_INVENT_FORBIDDEN,
  OPS_WAREHOUSE_UNWIRED,
  OPS_STRUCTURED_OWNER_PRICE_REQUIRED,
} from './codes.js';
import { OpsService } from './ops-service.js';
import { createOpsRouter } from './router.js';

const SECRET = 'a-ops-mount-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-ops' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['ops:read', 'ops:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

describe('svc-ops health — liveness is not a custodial stamp', () => {
  it('answers ok + service and does not stamp custodial:false', async () => {
    const api = createOpsRouter(new OpsService()).createCaller(await edgeContext({ headers: {}, id: 'anon' }));
    const health = await api.health();
    expect(health).toEqual({ ok: true, service: 'svc-ops' });
    expect(health).not.toHaveProperty('custodial');
  });

  it('router.ts health does not literal-stamp custodial:false', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'router.ts'), 'utf8');
    expect(src).not.toMatch(/custodial:\s*z\.literal\(false\)/);
    expect(src).not.toMatch(/custodial:\s*false\s+as const/);
  });
});

describe('svc-ops mount — strict screening', () => {
  // vitest.config.ts turns screening off for business fixtures; this test arms the production default
  // (unset INTAFACED_SCREENING_FAIL_CLOSED) and a blank list, and proves a signed request refuses.
  it('refuses a signed request with unconfigured screening and writes nothing', async () => {
    const service = new OpsService({ warehouseEnv: {} });
    const api = createOpsRouter(service).createCaller(await signed());
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', undefined);
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', undefined);
    vi.stubEnv('INTAFACED_UNSIGNED_SANCTIONS_ROWS', 'off');
    try {
      await expect(api.createContact({ displayName: 'Ada', email: 'ada@example.com' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { decision: { code: 'denied.screening_unconfigured' } },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    await expect(api.contacts({ limit: 50 })).resolves.toMatchObject({ contacts: [] });
  });
});

describe('svc-ops router', () => {
  it('blank warehouse revenue is PRECONDITION_FAILED ops.warehouse_unwired', async () => {
    const api = createOpsRouter(new OpsService({ warehouseEnv: {} })).createCaller(await signed());
    await expect(api.revenue()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_WAREHOUSE_UNWIRED),
    });
  });

  it('createContact + projects.create round-trip; inventPayroll named forbidden', async () => {
    let n = 0;
    const api = createOpsRouter(
      new OpsService({
        id: () => `id-${++n}`,
        warehouseEnv: { ANALYTICS_REPLICA_CONFIGURED: 'true', ANALYTICS_REPLICA_LAG_SECONDS: '5' },
      }),
    ).createCaller(await signed());

    const contact = await api.createContact({ displayName: 'Ada', email: 'ada@example.com' });
    const listed = await api.contacts({ limit: 50 });
    expect(listed.contacts).toContainEqual(contact);

    const project = await api.projects.create({ title: 'Lane K' });
    const projects = await api.projects.list({ limit: 50 });
    expect(projects.projects).toEqual([project]);

    const emptyRev = await api.revenue();
    expect(emptyRev.empty).toBe(true);
    expect(emptyRev.points).toEqual([]);

    await expect(api.inventPayroll({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_PAYROLL_INVENT_FORBIDDEN),
    });
  });

  it('fundraising.create + list + milestones; fund is ops.fundraising_chain_unwired; amounts stay strings', async () => {
    let n = 0;
    const api = createOpsRouter(new OpsService({ id: () => `id-${++n}` })).createCaller(await signed());

    const raise = await api.fundraising.create({
      name: 'Seed',
      milestoneLabels: ['legal', 'product'],
      targetAmount: '250.25',
    });
    expect(raise.targetAmount).toBe('250.25');
    expect(typeof raise.targetAmount).toBe('string');
    expect(raise).not.toHaveProperty('price');

    const listed = await api.fundraising.list({ limit: 50 });
    expect(listed.raises).toEqual([raise]);

    const miles = await api.fundraising.milestones({ limit: 50 });
    expect(miles.milestones.map((m) => m.label)).toEqual(['legal', 'product']);
    expect(miles.milestones.every((m) => typeof m.label === 'string')).toBe(true);

    const omitted = await api.fundraising.create({ name: 'Friends' });
    expect(omitted.targetAmount).toBeNull();

    await expect(api.fundraising.fund({ raiseId: raise.id, amount: '100' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_FUNDRAISING_CHAIN_UNWIRED),
    });
  });

  it('structured.create + list exposes only name and leg labels; missing owner price refuses', async () => {
    const unopened = createOpsRouter(new OpsService()).createCaller(await signed());
    await expect(unopened.structured.create({ name: 'Wrapped note', legLabels: ['principal'] })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_STRUCTURED_OWNER_PRICE_REQUIRED),
    });

    const api = createOpsRouter(new OpsService({ warehouseEnv: { STRUCTURED_OWNER_PRICE: 'owner-published' } })).createCaller(
      await signed(),
    );
    const record = await api.structured.create({ name: 'Wrapped note', legLabels: ['principal', 'coupon'] });
    expect(record).toEqual({ id: expect.any(String), name: 'Wrapped note', legLabels: ['principal', 'coupon'] });
    expect(record).not.toHaveProperty('price');
    expect((await api.structured.list({ limit: 50 })).records).toEqual([record]);
  });

  it('custody.list empty keys; wrap unset fail-closes wrap/execute; amounts stay strings', async () => {
    let n = 0;
    const api = createOpsRouter(new OpsService({ id: () => `id-${++n}`, custodyFreezePolicy: 'open' })).createCaller(await signed());

    const listed = await api.custody.list({ limit: 50 });
    expect(listed.wrap).toEqual({ status: 'unset', code: OPS_CUSTODY_WRAP_UNSET });
    expect(listed.freeze).toEqual({ status: 'open' });
    expect(listed.tiers.map((t) => t.id)).toEqual(['cold', 'warm', 'hot']);
    expect(listed.tiers.every((t) => t.keys.length === 0)).toBe(true);
    expect(listed.approvals).toEqual([]);

    const approval = await api.custody.createApproval({ fromTier: 'cold', toTier: 'warm', amount: '10.25' });
    expect(approval.amount).toBe('10.25');
    expect(typeof approval.amount).toBe('string');
    expect((await api.custody.list({ limit: 50 })).approvals).toEqual([approval]);

    await expect(api.custody.wrap({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_WRAP_UNSET),
    });
    await expect(api.custody.execute({ id: approval.id })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_WRAP_UNSET),
    });
  });

  it('custody wrap present still refuses keys and on-chain execute', async () => {
    const api = createOpsRouter(new OpsService({ custodyWrap: 'present', custodyFreezePolicy: 'open' })).createCaller(await signed());
    const listed = await api.custody.list({ limit: 50 });
    expect(listed.wrap).toEqual({ status: 'configured' });
    expect(listed.freeze).toEqual({ status: 'open' });
    expect(listed.tiers.every((t) => t.keys.length === 0)).toBe(true);
    await expect(api.custody.wrap({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_KEYS_FORBIDDEN),
    });
    await expect(api.custody.execute({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_CHAIN_UNWIRED),
    });
  });

  it('blank freeze policy refuses createApproval and execute — nothing queues', async () => {
    const api = createOpsRouter(new OpsService({ custodyWrap: 'present' })).createCaller(await signed());
    expect((await api.custody.list({ limit: 50 })).freeze).toEqual({ status: 'unset', code: OPS_CUSTODY_FREEZE_UNSET });
    await expect(api.custody.createApproval({ fromTier: 'cold', toTier: 'hot', amount: '10.00' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_FREEZE_UNSET),
    });
    await expect(api.custody.execute({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_FREEZE_UNSET),
    });
    expect((await api.custody.list({ limit: 50 })).approvals).toEqual([]);
  });

  it('frozen policy refuses createApproval and execute as ops.custody_frozen', async () => {
    const api = createOpsRouter(new OpsService({ custodyFreezePolicy: 'frozen', custodyWrap: 'present' })).createCaller(await signed());
    expect((await api.custody.list({ limit: 50 })).freeze).toEqual({ status: 'frozen', code: OPS_CUSTODY_FROZEN });
    await expect(api.custody.createApproval({ fromTier: 'cold', toTier: 'hot' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_FROZEN),
    });
    await expect(api.custody.execute({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(OPS_CUSTODY_FROZEN),
    });
    expect((await api.custody.list({ limit: 50 })).approvals).toEqual([]);
  });
});
