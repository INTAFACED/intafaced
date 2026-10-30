import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  createServiceSigner,
  createServiceVerifier,
  serviceAuthHeadersForBody,
  type Keyring,
  type ServiceName,
} from '@intafaced/contracts';
import { formatAmount, parseAmount as amt, recipes, type PostRequest } from '@intafaced/ledger-client';
import { LEDGER_POST_ALLOWLIST } from './caller-allowlist.js';
import { LEDGER_DOOR_CALLERS } from './door-callers.js';
import { callerBindingCounts, callerBindingViolationCount, resetCallerBindingViolations } from './caller-binding.js';
import { createLedgerRouter } from './router.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHARED = 'ledger-shared-internal-secret-32chars!';

function toWire(req: PostRequest) {
  return {
    idempotencyKey: req.idempotencyKey,
    module: req.module,
    reason: req.reason,
    ...(req.meta ? { meta: req.meta } : {}),
    entries: req.entries.map((entry) => ({
      account: entry.account,
      direction: entry.direction,
      amount: formatAmount(entry.amount),
    })),
  };
}

const orderHold = toWire(recipes.orderHold({ orderId: 'order-bind', userId: USER, assetId: 'USDT', amount: amt('10') }));

function interestOnlyRepay() {
  return toWire(
    recipes.loanRepay({
      loanId: 'ln-bind',
      userId: USER,
      debtAssetId: 'USDT',
      principal: 0n,
      interest: amt('1'),
      sequence: 1,
    }),
  );
}

function feeCharge(module: string) {
  return toWire(
    recipes.feeCharge({
      chargeId: 'charge-bind',
      userId: USER,
      module,
      mode: 'asset',
      assetId: 'USDT',
      amount: amt('1'),
      reason: 'agents.usage.metered',
    }),
  );
}

function stub(posted: { value: boolean }) {
  return {
    post: async () => {
      posted.value = true;
      return { id: 'tx-bind', hash: 'abc', postedAt: new Date('2026-10-17T00:00:00Z') };
    },
  } as unknown as LedgerService;
}

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
  };
}

/** Real generated keys for the callers, and the ledger's verifier built from the public keyring only. */
function kit() {
  const callers: ServiceName[] = ['svc-trade', 'svc-pay', 'svc-agents', 'svc-bank', 'svc-edge'];
  const keys = callers.map((svc) => ({ svc, ...pair() }));
  const keyring: Keyring = keys.map((k) => ({ kid: `${k.svc}.a`, svc: k.svc, use: 's2s' as const, x: k.x }));
  const signer = (svc: ServiceName) =>
    createServiceSigner({ service: svc, kid: `${svc}.a`, privateKey: keys.find((k) => k.svc === svc)!.privateKey, keyring });
  return { keyring, signer, verifier: () => createServiceVerifier({ self: 'svc-ledger', keyring, bootSecond: 0 }) };
}

type Kit = ReturnType<typeof kit>;
type Mode = 'dual' | 'keypair' | 'off';

async function mount(options: { mode: Mode; posted: { value: boolean }; k?: Kit; lines?: string[]; onViolation?: () => void }) {
  const k = options.k ?? kit();
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      options.lines?.push(String(chunk));
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'warn', stream } });
  registerS2sHttp(app, stub(options.posted), SHARED, {
    bodyBind: 'require',
    ...(options.mode === 'off' ? {} : { s2s: { verifier: k.verifier(), mode: options.mode } }),
    onCallerViolation: options.onViolation,
  });
  await app.ready();
  return { app, k };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

/** Signed by the named service's own key. */
function sendKeyed(m: Mounted, service: ServiceName, body: unknown, path = '/trpc/post', audience: ServiceName = 'svc-ledger') {
  const payload = JSON.stringify(body);
  const headers = m.k.signer(service).headers({
    audience,
    method: 'POST',
    url: new URL(`http://svc-ledger.internal${path}`),
    body: payload,
    context: { contentType: 'application/json' },
  });
  return m.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', ...headers }, payload });
}

/** Signed with the shared secret, claiming a name. */
function sendShared(m: Mounted, service: string, body: unknown) {
  const payload = JSON.stringify(body);
  return m.app.inject({
    method: 'POST',
    url: '/trpc/post',
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SHARED, payload) },
    payload,
  });
}

afterEach(() => {
  resetCallerBindingViolations();
});

describe('ledger post allowlist cites real callers', () => {
  it('every grant file calls that recipe', () => {
    for (const grants of Object.values(LEDGER_POST_ALLOWLIST)) {
      for (const [recipe, grant] of Object.entries(grants)) {
        const cite = grant.cite;
        const text = readFileSync(join(ROOT, cite), 'utf8');
        expect(text, cite).toMatch(new RegExp('recipes\\.' + recipe + '\\('));
      }
    }
  });

  it('does not grant subAccountTransfer — identity only mentions it in a comment', () => {
    const granted = Object.values(LEDGER_POST_ALLOWLIST).flatMap((grants) => Object.keys(grants));
    expect(granted).not.toContain('subAccountTransfer');
  });

  it('grants every production recipes.<name>( pair', () => {
    const pairs = new Set<string>();
    const servicesDir = join(ROOT, 'services');
    for (const service of readdirSync(servicesDir)) {
      if (!service.startsWith('svc-') || service === 'svc-ledger') continue;
      const src = join(servicesDir, service, 'src');
      if (!existsSync(src)) continue;
      for (const file of productionSources(src)) {
        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/recipes\.([A-Za-z0-9_]+)\(/g)) {
          const recipe = match[1];
          if (recipe) pairs.add(`${service} ${recipe}`);
        }
      }
    }

    const allowlist = new Set<string>();
    for (const [service, grants] of Object.entries(LEDGER_POST_ALLOWLIST)) {
      for (const recipe of Object.keys(grants)) allowlist.add(`${service} ${recipe}`);
    }
    const missing = [...pairs].filter((pair) => !allowlist.has(pair)).sort();
    const stray = [...allowlist].filter((pair) => !pairs.has(pair)).sort();
    expect({ missing, stray }).toEqual({ missing: [], stray: [] });
  });
});

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === '__tests__' || entry.name === 'scripts') continue;
      out.push(...productionSources(path));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
    out.push(path);
  }
  return out;
}

describe('POST /trpc/post caller binding', () => {
  for (const mode of ['dual', 'keypair'] as const) {
    it(`${mode}: posts an allowed pair signed by that service's own key`, async () => {
      const posted = { value: false };
      const m = await mount({ mode, posted });
      const before = callerBindingViolationCount();

      const res = await sendKeyed(m, 'svc-trade', orderHold);

      expect(res.statusCode).toBe(200);
      expect(posted.value).toBe(true);
      expect(callerBindingViolationCount()).toBe(before);
      await m.app.close();
    });

    it(`${mode}: refuses a different service posting that recipe, and books nothing`, async () => {
      const posted = { value: false };
      const m = await mount({ mode, posted });

      const res = await sendKeyed(m, 'svc-pay', orderHold);

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ledger.caller_forbidden');
      expect(posted.value).toBe(false);
      await m.app.close();
    });
  }

  it('refuses a spoofed module on a body the caller is otherwise allowed to shape', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'keypair', posted });

    const res = await sendKeyed(m, 'svc-agents', feeCharge('trade'));

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(String(res.json().message)).toContain('module trade');
    expect(posted.value).toBe(false);
    await m.app.close();
  });

  it('posts the same fee when the module is the one svc-agents actually sends', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'keypair', posted });

    const res = await sendKeyed(m, 'svc-agents', feeCharge('agents'));

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    await m.app.close();
  });

  it('counts and logs an off-list key-signed post, and refuses it in dual mode too', async () => {
    const posted = { value: false };
    const lines: string[] = [];
    let reported = 0;
    const m = await mount({
      mode: 'dual',
      posted,
      lines,
      onViolation: () => {
        reported += 1;
      },
    });

    const res = await sendKeyed(m, 'svc-pay', orderHold);

    expect(res.statusCode).toBe(403);
    expect(posted.value).toBe(false);
    expect(reported).toBe(1);
    expect(callerBindingViolationCount()).toBe(1);
    expect(lines.join('\n')).toContain('ledger caller binding violation');
    await m.app.close();
  });

  it('keypair refuses the shared secret before anything is judged', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'keypair', posted });

    const res = await sendShared(m, 'svc-trade', orderHold);

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ledger.unauthenticated');
    expect(posted.value).toBe(false);
    await m.app.close();
  });

  it('dual still posts a shared-secret call for an allowed claim and counts it as unbound', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'dual', posted });

    const res = await sendShared(m, 'svc-trade', orderHold);

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(callerBindingCounts()).toEqual([{ reason: 'unbound', service: 'svc-trade', count: 1 }]);
    await m.app.close();
  });

  it('warns once and counts three legacy posts from the same claimed service', async () => {
    const posted = { value: false };
    const lines: string[] = [];
    const m = await mount({ mode: 'dual', posted, lines });

    for (let i = 0; i < 3; i += 1) {
      const res = await sendShared(m, 'svc-trade', orderHold);
      expect(res.statusCode).toBe(200);
    }

    const warns = lines.join('').match(/ledger caller binding violation/g) ?? [];
    expect(warns).toHaveLength(1);
    expect(callerBindingCounts()).toEqual([{ reason: 'unbound', service: 'svc-trade', count: 3 }]);
    await m.app.close();
  });

  it('does not fall back to the shared secret when a key-signed call fails', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'dual', posted });
    const payload = JSON.stringify(orderHold);
    const headers = m.k.signer('svc-trade').headers({
      audience: 'svc-bank',
      method: 'POST',
      url: new URL('http://svc-ledger.internal/trpc/post'),
      body: payload,
      context: { contentType: 'application/json' },
    });

    const res = await m.app.inject({
      method: 'POST',
      url: '/trpc/post',
      headers: { 'content-type': 'application/json', ...headers, ...serviceAuthHeadersForBody('svc-trade', SHARED, payload) },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(posted.value).toBe(false);
    await m.app.close();
  });

  it('refuses a replay of the same signed post', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'keypair', posted });
    const payload = JSON.stringify(orderHold);
    const headers = m.k.signer('svc-trade').headers({
      audience: 'svc-ledger',
      method: 'POST',
      url: new URL('http://svc-ledger.internal/trpc/post'),
      body: payload,
      context: { contentType: 'application/json' },
    });
    const call = () =>
      m.app.inject({ method: 'POST', url: '/trpc/post', headers: { 'content-type': 'application/json', ...headers }, payload });

    expect((await call()).statusCode).toBe(200);
    const replay = await call();
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('ledger.unauthenticated');
    expect(posted.value).toBe(true);
    await m.app.close();
  });

  it('refuses a call signed for another audience', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'keypair', posted });

    const res = await sendKeyed(m, 'svc-trade', orderHold, '/trpc/post', 'svc-bank');

    expect(res.statusCode).toBe(401);
    expect(posted.value).toBe(false);
    await m.app.close();
  });

  it('posts an interest-only loan repayment from svc-bank and refuses it from svc-pay', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'keypair', posted });

    expect((await sendKeyed(m, 'svc-bank', interestOnlyRepay())).statusCode).toBe(200);
    posted.value = false;
    const res = await sendKeyed(m, 'svc-pay', interestOnlyRepay());

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(posted.value).toBe(false);
    await m.app.close();
  });
});

describe('every door names its callers', () => {
  const READ_BODY = { ownerType: 'treasury', ownerId: 'rail:crypto-native' };

  it('declares exactly the 20 doors registerS2sHttp serves', () => {
    const source = readFileSync(join(ROOT, 'services/svc-ledger/src/s2s-http.ts'), 'utf8');
    const served = [...source.matchAll(/'\/trpc\/([A-Za-z]+)'/g)].map((match) => match[1]).sort();
    expect(Object.keys(LEDGER_DOOR_CALLERS).sort()).toEqual([...new Set(served)]);
    expect(served).toHaveLength(20);
  });

  it('refuses a key-verified service that a read door does not list', async () => {
    const m = await mount({ mode: 'keypair', posted: { value: false } });

    const res = await sendKeyed(m, 'svc-edge', READ_BODY, '/trpc/balance');

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(String(res.json().message)).toContain('svc-edge');
    await m.app.close();
  });

  it('dual lets a shared-secret claim of an unlisted name reach a door, since the name is not proof', async () => {
    const m = await mount({ mode: 'dual', posted: { value: false } });
    const payload = JSON.stringify(READ_BODY);

    const res = await m.app.inject({
      method: 'POST',
      url: '/trpc/custody',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('local-test-seed', SHARED, payload) },
      payload,
    });

    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    await m.app.close();
  });

  it('refuses every caller on a door with no named caller', async () => {
    const m = await mount({ mode: 'keypair', posted: { value: false } });

    for (const door of ['portfolio', 'statementPnl', 'reportExport', 'custody', 'financeClose', 'resilience'] as const) {
      expect(LEDGER_DOOR_CALLERS[door]).toEqual([]);
      const res = await sendKeyed(m, 'svc-bank', READ_BODY, `/trpc/${door}`);
      expect(res.statusCode, door).toBe(403);
    }
    await m.app.close();
  });

  it('lets a listed service reach a read door and rejects an unsigned one', async () => {
    const m = await mount({ mode: 'keypair', posted: { value: false } });

    const ledger = {
      balance: async () => ({ accountId: 'acct-1', amount: amt('5') }),
    } as unknown as LedgerService;
    const app = Fastify({ logger: false });
    registerS2sHttp(app, ledger, SHARED, { bodyBind: 'require', s2s: { verifier: m.k.verifier(), mode: 'keypair' } });
    await app.ready();
    const listed = await sendKeyed(
      { app, k: m.k },
      'svc-bank',
      { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' },
      '/trpc/balance',
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json().amount).toBe('5');
    await app.close();
    const anon = await m.app.inject({
      method: 'POST',
      url: '/trpc/balance',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(READ_BODY),
    });
    expect(anon.statusCode).toBe(401);
    await m.app.close();
  });
});

describe('tRPC post applies the same allowlist', () => {
  function caller(service: string | null, posted: { value: boolean }, serviceAuth?: 'keypair' | 'shared') {
    return createLedgerRouter(stub(posted)).createCaller({
      principal: null,
      service,
      serviceAuth,
      region: 'DE',
      requestId: 'bind',
    });
  }

  it('refuses svc-pay posting a trade recipe when its key verified, and books nothing', async () => {
    const posted = { value: false };
    await expect(caller('svc-pay', posted, 'keypair').post(orderHold)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(posted.value).toBe(false);
  });

  it('accepts svc-trade posting its own order hold when its key verified', async () => {
    const posted = { value: false };
    await expect(caller('svc-trade', posted, 'keypair').post(orderHold)).resolves.toMatchObject({ txId: 'tx-bind' });
    expect(posted.value).toBe(true);
  });

  it('refuses a missing service name', async () => {
    const posted = { value: false };
    await expect(caller(null, posted).post(orderHold)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(posted.value).toBe(false);
  });

  it('refuses a service that holds no grant on the post door at all', async () => {
    const posted = { value: false };
    await expect(caller('svc-edge', posted, 'keypair').post(orderHold)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(posted.value).toBe(false);
  });
});

describe('service-call settings at boot', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_POOL_MAX: '10',
    INTERNAL_SERVICE_SECRET: SHARED,
    JWT_ACCESS_SECRET: SHARED,
    RECONCILE_CRON_MINUTES: '60',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(overrides: Record<string, string> = {}) {
    vi.resetModules();
    for (const [key, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(key, value);
    return (await import('./env.js')).env;
  }

  it('boots with no service-call settings, and with a mode set', async () => {
    expect((await load()).S2S_AUTH_MODE).toBe('off');
    expect((await load({ S2S_AUTH_MODE: 'dual' })).S2S_AUTH_MODE).toBe('dual');
  });

  it('no longer reads the report/enforce knob or per-service secrets', async () => {
    const parsed = (await load({ LEDGER_CALLER_BINDING: 'enforce', LEDGER_CALLER_SECRET_SVC_PAY: 'x'.repeat(40) })) as Record<
      string,
      unknown
    >;
    expect(parsed).not.toHaveProperty('LEDGER_CALLER_BINDING');
    expect(parsed).not.toHaveProperty('LEDGER_CALLER_SECRET_SVC_PAY');
  });
});

describe('the token buyback recipes need a key once keys exist', () => {
  /** TEST amounts only. */
  const buyback = [
    ['buybackOrderHold', toWire(recipes.buybackOrderHold({ orderId: 'bb-bind', quoteAsset: 'USDT', amount: amt('10') }))],
    [
      'buybackOrderHoldRelease',
      toWire(recipes.buybackOrderHoldRelease({ orderId: 'bb-bind', quoteAsset: 'USDT', amount: amt('10'), sequence: 0 })),
    ],
    [
      'buybackTakerFill',
      toWire(
        recipes.buybackTakerFill({
          fillId: 'bb-bind-fill',
          makerId: USER,
          makerOrderId: 'bb-bind-ask',
          takerOrderId: 'bb-bind',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          qty: amt('1'),
          quoteAmount: amt('10'),
          makerFeeBps: 0,
        }),
      ),
    ],
  ] as const;

  it.each(buyback)('dual refuses a shared-secret %s, even under the granted name', async (_name, body) => {
    const posted = { value: false };
    const m = await mount({ mode: 'dual', posted });
    const res = await sendShared(m, 'svc-trade', body);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ledger.caller_unbound');
    expect(posted.value).toBe(false);
    // Refused, and still counted as an unbound post under the claimed name.
    expect(callerBindingCounts()).toEqual([{ reason: 'unbound', service: 'svc-trade', count: 1 }]);
    await m.app.close();
  });

  it.each(buyback)('dual posts a key-signed %s from svc-trade', async (_name, body) => {
    const posted = { value: false };
    const m = await mount({ mode: 'dual', posted });
    const res = await sendKeyed(m, 'svc-trade', body);
    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    await m.app.close();
  });

  it('dual still only counts a shared-secret post of an unrelated recipe', async () => {
    const posted = { value: false };
    const m = await mount({ mode: 'dual', posted });
    const res = await sendShared(m, 'svc-trade', orderHold);
    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(callerBindingCounts()).toEqual([{ reason: 'unbound', service: 'svc-trade', count: 1 }]);
    await m.app.close();
  });

  it.each(buyback)('with keys off, a shared-secret %s is only counted, as every recipe is', async (_name, body) => {
    const posted = { value: false };
    const m = await mount({ mode: 'off', posted });
    const res = await sendShared(m, 'svc-trade', body);
    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(callerBindingCounts()).toEqual([{ reason: 'unbound', service: 'svc-trade', count: 1 }]);
    await m.app.close();
  });
});
