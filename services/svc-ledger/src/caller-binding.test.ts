import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { formatAmount, parseAmount as amt, recipes, type PostRequest } from '@intafaced/ledger-client';
import { LEDGER_POST_ALLOWLIST } from './caller-allowlist.js';
import { callerBindingViolationCount, resetCallerBindingViolations } from './caller-binding.js';
import { createLedgerRouter } from './router.js';
import { registerS2sHttp } from './s2s-http.js';
import type { LedgerService } from './service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHARED = 'ledger-shared-internal-secret-32chars!';
const TRADE_SECRET = 'ledger-caller-secret-svc-trade-32ch!';
const PAY_SECRET = 'ledger-caller-secret-svc-pay-32chars!';
const AGENTS_SECRET = 'ledger-caller-secret-svc-agents-32ch!';

const SECRETS = {
  'svc-trade': TRADE_SECRET,
  'svc-pay': PAY_SECRET,
  'svc-agents': AGENTS_SECRET,
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
  it('every grant line calls that recipe', () => {
    for (const grants of Object.values(LEDGER_POST_ALLOWLIST)) {
      for (const [recipe, grant] of Object.entries(grants)) {
        const splitAt = grant.cite.lastIndexOf(':');
        const file = grant.cite.slice(0, splitAt);
        const lineNo = Number(grant.cite.slice(splitAt + 1));
        const line = readFileSync(join(ROOT, file), 'utf8').split('\n')[lineNo - 1] ?? '';
        expect(line, grant.cite).toContain(`recipes.${recipe}`);
      }
    }
  });

  it('does not grant subAccountTransfer — identity only mentions it in a comment', () => {
    const granted = Object.values(LEDGER_POST_ALLOWLIST).flatMap((grants) => Object.keys(grants));
    expect(granted).not.toContain('subAccountTransfer');
  });
});

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
    const before = callerBindingViolationCount();

    const res = await send(app, 'svc-trade', SHARED, orderHold);

    expect(res.statusCode).toBe(200);
    expect(posted.value).toBe(true);
    expect(callerBindingViolationCount()).toBe(before);
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
});
