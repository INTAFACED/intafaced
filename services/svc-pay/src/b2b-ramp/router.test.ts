import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createFounderAuthority } from '../founder-authority.js';
import { createPayNamespaces, findUnguardedFounderProcedures } from '../namespaces/index.js';
import type { MerchantRole } from '../merchant-ops/roles.js';
import { createB2bRampRouter, type B2bRampCreditPort } from './router.js';
import type { B2bCreditInput, B2bCreditResult } from './socket.js';
import type { B2bRampAccess } from './access.js';

const here = dirname(fileURLToPath(import.meta.url));
const id = () => randomUUID();
const merchantId = id();
const userId = id();
const creditId = id();

const base: Principal = {
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60_000),
};

const ctxOf = (principal: Principal | null): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: principal ? { raw: 'test-principal', signature: 'test-signature', region: 'DE' } : undefined,
});

const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const entitlement = (status: string, forUser = userId) =>
  new Response(JSON.stringify({ result: { data: { status, userId: forUser, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const credited: B2bCreditResult = {
  creditId,
  merchantId,
  bankLineId: 'line-1',
  amount: '10.1',
  asset: 'USD',
  reconciled: true,
  ledgerPosted: false,
};

function accessFor(role: MerchantRole | null): B2bRampAccess & { calls: number } {
  return {
    calls: 0,
    async roleFor() {
      this.calls += 1;
      return role;
    },
  };
}

function portSpy(): B2bRampCreditPort & { credits: B2bCreditInput[]; gets: string[] } {
  return {
    credits: [],
    gets: [],
    async credit(input) {
      this.credits.push(input);
      return { ...credited, merchantId: input.merchantId, bankLineId: input.bankLineId, asset: input.asset, amount: '10.1' };
    },
    async get(credit) {
      this.gets.push(credit);
      return credit === creditId ? credited : null;
    },
  };
}

type Err = { code: string; message: string; cause?: { code?: string } };

async function call(run: () => Promise<unknown>): Promise<Err> {
  try {
    await run();
    throw new Error('expected a refusal');
  } catch (error) {
    if (error instanceof Error && error.message === 'expected a refusal') throw error;
    return error as Err;
  }
}

const off = { PAY_B2B_RAMP: 'off', APP_ENV: 'prod' };
const on = { PAY_B2B_RAMP: 'on', APP_ENV: 'test' };

describe('b2b ramp routes while the flag is off', () => {
  const authority = createFounderAuthority({ ...identity, fetcher: vi.fn(async () => entitlement('enabled')) });
  const access = accessFor('owner');
  const port = portSpy();
  const caller = createB2bRampRouter({ founderAuthority: authority, env: off, access, port }).createCaller(ctxOf(base));

  it('refuses status, credit and get on a direct caller, and does not touch the merchant or the socket', async () => {
    const status = await call(() => caller.b2bRamp.status({ merchantId }));
    const credit = await call(() =>
      caller.b2bRamp.credit({
        merchantId,
        bankLineId: 'line-1',
        amount: '10.00',
        asset: 'USD',
        clientSettledAmount: '999999.00',
      }),
    );
    const got = await call(() => caller.b2bRamp.get({ creditId }));
    for (const error of [status, credit, got]) {
      expect(error.code).toBe('FORBIDDEN');
      expect(error.cause?.code).toBe('pay.b2b_ramp_off');
      expect(error.message).toBe('pay.b2b_ramp_off');
    }
    expect(access.calls).toBe(0);
    expect(port.credits).toEqual([]);
    expect(port.gets).toEqual([]);
  });

  it('refuses founder status for a live founder, with no merchant payload', async () => {
    const founder = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn(async () => entitlement('enabled')) }),
      env: off,
      access,
      port,
    }).createCaller(ctxOf(base));
    const error = await call(() => founder.b2bRamp.founderStatus());
    expect(error.code).toBe('FORBIDDEN');
    expect(error.cause?.code).toBe('pay.b2b_ramp_off');
  });

  it('refuses a caller with no pay scope before the stub could answer', async () => {
    const narrow = createB2bRampRouter({ founderAuthority: authority, env: off }).createCaller(ctxOf({ ...base, scopes: ['trade:read'] }));
    const error = await call(() => narrow.b2bRamp.status({ merchantId }));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.cause?.code).not.toBe('pay.b2b_ramp_off');
  });

  it('refuses an anonymous direct caller as unauthenticated', async () => {
    const anon = createB2bRampRouter({ founderAuthority: authority, env: off }).createCaller(ctxOf(null));
    expect((await call(() => anon.b2bRamp.status({ merchantId }))).code).toBe('UNAUTHORIZED');
    expect((await call(() => anon.b2bRamp.credit({ merchantId, bankLineId: 'x', amount: '1', asset: 'USD' }))).code).toBe('UNAUTHORIZED');
  });
});

describe('b2b ramp routes while the flag is on', () => {
  it('founder status carries no merchant rows or attestation text', async () => {
    const secret = 'do-not-echo-this-attestation';
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    const ramp = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher }),
      env: { PAY_B2B_RAMP: 'on', APP_ENV: 'prod', PAY_B2B_RAMP_LICENCE_ATTESTATION: secret },
    });
    const founder = ramp.createCaller(ctxOf(base));
    const status = await founder.b2bRamp.founderStatus();
    expect(Object.keys(status).sort()).toEqual(['deferred', 'enabled', 'flag', 'licenceAttestation', 'reconciliationSocket']);
    expect(status).toMatchObject({
      flag: 'pay.b2b_ramp',
      enabled: true,
      licenceAttestation: 'present',
      reconciliationSocket: 'wired',
      deferred: ['intake', 'batches', 'executions', 'events'],
    });
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it('a non-founder is refused, and an API key is refused before identity is asked', async () => {
    const denied = vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }));
    const ramp = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: denied }),
      env: on,
    });
    const error = await call(() => ramp.createCaller(ctxOf(base)).b2bRamp.founderStatus());
    expect(error.code).toBe('FORBIDDEN');
    expect(error.cause?.code).not.toBe('pay.b2b_ramp_off');

    const keyed = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    const keys = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: keyed }),
      env: on,
    });
    const keyError = await call(() => keys.createCaller(ctxOf({ ...base, kid: id() })).b2bRamp.founderStatus());
    expect(keyError.code).toBe('FORBIDDEN');
    expect(keyed).not.toHaveBeenCalled();
  });

  it('status is tenant-scoped: a stranger and a missing merchant are the same not-found', async () => {
    const ramp = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn() }),
      env: on,
      access: {
        async roleFor() {
          return null;
        },
      },
    });
    const error = await call(() => ramp.createCaller(ctxOf(base)).b2bRamp.status({ merchantId }));
    expect(error).toMatchObject({ code: 'NOT_FOUND', cause: { code: 'pay.merchant_not_found' } });
  });

  it('an owner can read status; a viewer cannot credit; finance can, and the client claim is not passed', async () => {
    const roles = new Map<string, MerchantRole>([[merchantId, 'viewer']]);
    const access: B2bRampAccess = {
      async roleFor(_user, id) {
        return roles.get(id) ?? null;
      },
    };
    const port = portSpy();
    const ramp = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn() }),
      env: on,
      access,
      port,
    });
    const caller = ramp.createCaller(ctxOf(base));
    const status = await caller.b2bRamp.status({ merchantId });
    expect(status.merchantId).toBe(merchantId);
    expect(status.enabled).toBe(true);
    expect(status.licenceAttestation).toBe('absent');

    const viewer = await call(() =>
      caller.b2bRamp.credit({
        merchantId,
        bankLineId: 'line-1',
        amount: '10.00',
        asset: 'USD',
        clientSettledAmount: '999999.00',
      }),
    );
    expect(viewer).toMatchObject({ code: 'FORBIDDEN', cause: { code: 'pay.team_role_forbidden' } });
    expect(port.credits).toEqual([]);

    roles.set(merchantId, 'finance');
    const admitted = await caller.b2bRamp.credit({
      merchantId,
      bankLineId: 'line-1',
      amount: '10.00',
      asset: 'USD',
      clientSettledAmount: '999999.00',
    });
    expect(admitted.ledgerPosted).toBe(false);
    expect(port.credits).toEqual([{ merchantId, bankLineId: 'line-1', amount: '10.00', asset: 'USD' }]);
    expect(port.credits[0]).not.toHaveProperty('clientSettledAmount');
  });

  it('a credit the caller does not own is the same not-found as a missing credit, and does not echo the amount', async () => {
    const port: B2bRampCreditPort = {
      async credit() {
        throw new Error('credit not used');
      },
      async get(credit) {
        return credit === creditId ? { ...credited, amount: '10.5' } : null;
      },
    };
    const ramp = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn() }),
      env: on,
      access: {
        async roleFor() {
          return null;
        },
      },
      port,
    });
    const caller = ramp.createCaller(ctxOf(base));
    const foreign = await call(() => caller.b2bRamp.get({ creditId }));
    const missing = await call(() => caller.b2bRamp.get({ creditId: id() }));
    expect(foreign).toMatchObject({ code: 'NOT_FOUND', message: 'pay.b2b_ramp_not_found' });
    expect(missing.code).toBe(foreign.code);
    expect(missing.message).toBe(foreign.message);
    expect(JSON.stringify(foreign)).not.toContain('10.5');
  });

  it('enabling in prod without an attestation refuses the request closed if the process is somehow up', async () => {
    const ramp = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn(async () => entitlement('enabled')) }),
      env: { PAY_B2B_RAMP: 'on', APP_ENV: 'prod' },
      access: accessFor('owner'),
    });
    const error = await call(() => ramp.createCaller(ctxOf(base)).b2bRamp.founderStatus());
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', cause: { code: 'pay.b2b_ramp_boot_refused' } });
  });
});

describe('b2b ramp route inventory', () => {
  it('exposes only status, credit, get and founder status — no intake, batch, or bank-line write', () => {
    const ramp = createB2bRampRouter({
      founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn() }),
      env: off,
    });
    const paths = Object.keys((ramp as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures).sort();
    expect(paths).toEqual(['b2bRamp.credit', 'b2bRamp.founderStatus', 'b2bRamp.get', 'b2bRamp.status']);
  });

  it('is mounted on the pay namespaces, and founder status is guarded ahead of input', () => {
    const r = createPayNamespaces({ founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn() }) });
    expect(findUnguardedFounderProcedures(r, ['b2bRamp.founderStatus'])).toEqual([]);
    const src = readFileSync(join(here, '..', 'namespaces', 'index.ts'), 'utf8');
    expect(src).toContain('createB2bRampRouter');
  });

  it('does not post to the ledger from this module', () => {
    const files = readdirSync(here).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    for (const name of files) {
      const src = readFileSync(join(here, name), 'utf8');
      expect(src, name).not.toMatch(/ledger\.post|postTransfer|createLedgerClient|MemoryLedger/);
      if (name !== 'money.ts') expect(src, name).not.toMatch(/@intafaced\/ledger-client/);
    }
    const money = readFileSync(join(here, 'money.ts'), 'utf8');
    expect(money).toMatch(/parseAmount/);
    expect(money).toMatch(/formatAmount/);
  });
});
