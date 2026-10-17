import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { formatAmount, parseAmount as amt, recipes, type PostRequest } from '@intafaced/ledger-client';
import { CALLER_SECRET_ENV_NAMES, LEDGER_CALLER_SERVICES, LEDGER_POST_ALLOWLIST, callerSecretEnvName } from './caller-allowlist.js';
import { callerBindingCounts, callerBindingViolationCount, resetCallerBindingViolations } from './caller-binding.js';
import { createLedgerRouter } from './router.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHARED = 'ledger-shared-internal-secret-32chars!';
const TRADE_SECRET = 'ledger-caller-secret-svc-trade-32ch!';
const PAY_SECRET = 'ledger-caller-secret-svc-pay-32chars!';
const AGENTS_SECRET = 'ledger-caller-secret-svc-agents-32ch!';
const BANK_SECRET = 'ledger-caller-secret-svc-bank-32ch!';

const SECRETS = {
  'svc-trade': TRADE_SECRET,
  'svc-pay': PAY_SECRET,
  'svc-agents': AGENTS_SECRET,
  'svc-bank': BANK_SECRET,
};

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

async function mount(options: { mode: 'report' | 'enforce'; posted: { value: boolean }; lines?: string[]; onViolation?: () => void }) {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      options.lines?.push(String(chunk));
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'warn', stream } });
  registerS2sHttp(app, stub(options.posted), SHARED, {
    bodyBind: 'require',
    callerBinding: options.mode,
    callerSecrets: SECRETS,
    onCallerViolation: options.onViolation,
  });
  await app.ready();
  return app;
}

function send(app: Awaited<ReturnType<typeof mount>>, service: string, secret: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/trpc/post',
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, secret, payload) },
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

  it('names one secret env var per allowlisted service', () => {
    expect([...CALLER_SECRET_ENV_NAMES].sort()).toEqual(LEDGER_CALLER_SERVICES.map((service) => callerSecretEnvName(service)).sort());
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
  it('posts an allowed pair when the key id matches that service secret', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'enforce', posted });
    const before = callerBindingViolationCount();

    const res = await send(app, 'svc-trade', TRADE_SECRET, orderHold);

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(callerBindingViolationCount()).toBe(before);
    await app.close();
  });

  it('refuses a different service posting that recipe in enforce, and books nothing', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'enforce', posted });

    const res = await send(app, 'svc-pay', PAY_SECRET, orderHold);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(posted.value).toBe(false);
    await app.close();
  });

  it('refuses a spoofed module on a body the caller is otherwise allowed to shape', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'enforce', posted });

    const res = await send(app, 'svc-agents', AGENTS_SECRET, feeCharge('trade'));

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(String(res.json().message)).toContain('module trade');
    expect(posted.value).toBe(false);
    await app.close();
  });

  it('posts the same fee when the module is the one svc-agents actually sends', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'enforce', posted });

    const res = await send(app, 'svc-agents', AGENTS_SECRET, feeCharge('agents'));

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    await app.close();
  });

  it('logs and counts a mismatch in report mode, and still posts', async () => {
    const posted = { value: false };
    const lines: string[] = [];
    let reported = 0;
    const app = await mount({
      mode: 'report',
      posted,
      lines,
      onViolation: () => {
        reported += 1;
      },
    });
    const before = callerBindingViolationCount();

    const res = await send(app, 'svc-pay', PAY_SECRET, orderHold);

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(reported).toBe(1);
    expect(callerBindingViolationCount()).toBe(before + 1);
    expect(lines.join('\n')).toContain('ledger caller binding violation');
    await app.close();
  });

  it('refuses the shared secret in enforce — that signature does not name a service', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'enforce', posted });

    const res = await send(app, 'svc-trade', SHARED, orderHold);

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('ledger.caller_unbound');
    expect(posted.value).toBe(false);
    await app.close();
  });

  it('still posts a shared-secret call for an allowed claim while the mode is report', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'report', posted });

    const res = await send(app, 'svc-trade', SHARED, orderHold);

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(callerBindingCounts()).toEqual([{ reason: 'unbound', service: 'svc-trade', count: 1 }]);
    await app.close();
  });

  it('warns once and counts three legacy posts from the same claimed service', async () => {
    const posted = { value: false };
    const lines: string[] = [];
    const app = await mount({ mode: 'report', posted, lines });

    for (let i = 0; i < 3; i += 1) {
      const res = await send(app, 'svc-trade', SHARED, orderHold);
      expect(res.statusCode).toBe(200);
    }

    expect(posted.value).toBe(true);
    const warns = lines.join('').match(/ledger caller binding violation/g) ?? [];
    expect(warns).toHaveLength(1);
    expect(callerBindingCounts()).toEqual([{ reason: 'unbound', service: 'svc-trade', count: 3 }]);
    await app.close();
  });

  it('posts an interest-only loan repayment from bound svc-bank in enforce', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'enforce', posted });
    const before = callerBindingViolationCount();

    const res = await send(app, 'svc-bank', BANK_SECRET, interestOnlyRepay());

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(callerBindingViolationCount()).toBe(before);
    await app.close();
  });

  it('refuses that interest-only repayment from bound svc-pay in enforce', async () => {
    const posted = { value: false };
    const app = await mount({ mode: 'enforce', posted });

    const res = await send(app, 'svc-pay', PAY_SECRET, interestOnlyRepay());

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ledger.caller_forbidden');
    expect(posted.value).toBe(false);
    await app.close();
  });
});

describe('tRPC post applies the same allowlist', () => {
  function caller(service: string | null, mode: 'report' | 'enforce', posted: { value: boolean }, serviceAuth?: 'dedicated' | 'shared') {
    const serviceStub = stub(posted);
    return createLedgerRouter(serviceStub, undefined, undefined, { mode }).createCaller({
      principal: null,
      service,
      serviceAuth,
      region: 'DE',
      requestId: 'bind',
    });
  }

  it('refuses svc-pay posting a trade recipe in enforce, and books nothing', async () => {
    const posted = { value: false };
    await expect(caller('svc-pay', 'enforce', posted, 'dedicated').post(orderHold)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(posted.value).toBe(false);
  });

  it('accepts svc-trade posting its own order hold when that service secret matched', async () => {
    const posted = { value: false };
    await expect(caller('svc-trade', 'enforce', posted, 'dedicated').post(orderHold)).resolves.toMatchObject({ txId: 'tx-bind' });
    expect(posted.value).toBe(true);
  });

  it('refuses a service name that was not proven with that service secret', async () => {
    const posted = { value: false };
    await expect(caller('svc-trade', 'enforce', posted, 'shared').post(orderHold)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(posted.value).toBe(false);
  });

  it('refuses a missing service name in enforce', async () => {
    const posted = { value: false };
    await expect(caller(null, 'enforce', posted).post(orderHold)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(posted.value).toBe(false);
  });
});

describe('LEDGER_CALLER_BINDING boot default', () => {
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

  async function load(overrides: Record<string, string | undefined> = {}) {
    vi.resetModules();
    for (const [key, value] of Object.entries({ ...base, ...overrides })) {
      if (value === undefined) vi.stubEnv(key, '');
      else vi.stubEnv(key, value);
    }
    const loaded = await import('./env.js');
    return loaded.env;
  }

  it('defaults a blank flag to report and treats a blank per-service secret as unset', async () => {
    const parsed = await load({ LEDGER_CALLER_BINDING: '', LEDGER_CALLER_SECRET_SVC_PAY: '' });
    expect(parsed.LEDGER_CALLER_BINDING).toBe('report');
    expect(parsed.LEDGER_CALLER_SECRET_SVC_PAY).toBeUndefined();
  });

  it('refuses a per-service secret shorter than 32 characters', async () => {
    await expect(load({ LEDGER_CALLER_SECRET_SVC_TRADE: 'too-short' })).rejects.toThrow(/LEDGER_CALLER_SECRET_SVC_TRADE/);
  });

  it('refuses a per-service secret equal to INTERNAL_SERVICE_SECRET', async () => {
    const err = await load({ LEDGER_CALLER_SECRET_SVC_PAY: `  ${SHARED}  ` }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : '';
    expect(message).toMatch(/LEDGER_CALLER_SECRET_SVC_PAY/);
    expect(message).toMatch(/INTERNAL_SERVICE_SECRET/);
    expect(message).not.toContain(SHARED);
  });

  it('refuses two per-service secrets that trim to the same value', async () => {
    const dup = 'ledger-caller-secret-duplicated-32ch!';
    const err = await load({
      LEDGER_CALLER_SECRET_SVC_PAY: dup,
      LEDGER_CALLER_SECRET_SVC_TRADE: `  ${dup}`,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : '';
    expect(message).toMatch(/LEDGER_CALLER_SECRET_SVC_PAY/);
    expect(message).toMatch(/LEDGER_CALLER_SECRET_SVC_TRADE/);
    expect(message).not.toContain(dup);
  });

  it('boots when per-service secrets differ from each other and from the shared secret', async () => {
    const parsed = await load({
      LEDGER_CALLER_SECRET_SVC_PAY: PAY_SECRET,
      LEDGER_CALLER_SECRET_SVC_TRADE: TRADE_SECRET,
    });
    expect(parsed.LEDGER_CALLER_SECRET_SVC_PAY).toBe(PAY_SECRET);
    expect(parsed.LEDGER_CALLER_SECRET_SVC_TRADE).toBe(TRADE_SECRET);
  });
});

describe('registerS2sHttp refuses secrets that void the binding', () => {
  it('refuses a dedicated secret equal to the shared secret', () => {
    const app = Fastify();
    expect(() => registerS2sHttp(app, stub({ value: false }), SHARED, { callerSecrets: { 'svc-pay': ` ${SHARED} ` } })).toThrow(
      /LEDGER_CALLER_SECRET_SVC_PAY must not equal INTERNAL_SERVICE_SECRET/,
    );
  });

  it('refuses two dedicated secrets that are equal', () => {
    const app = Fastify();
    const dup = 'ledger-caller-secret-duplicated-32ch!';
    expect(() =>
      registerS2sHttp(app, stub({ value: false }), SHARED, {
        callerSecrets: { 'svc-pay': dup, 'svc-trade': dup },
      }),
    ).toThrow(/LEDGER_CALLER_SECRET_SVC_TRADE must not equal LEDGER_CALLER_SECRET_SVC_PAY/);
  });

  it('boots when the dedicated secrets are distinct', async () => {
    const app = Fastify();
    expect(() => registerS2sHttp(app, stub({ value: false }), SHARED, { callerSecrets: SECRETS })).not.toThrow();
    await app.close();
  });
});
