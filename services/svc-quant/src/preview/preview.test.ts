import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  PREVIEW_LABEL,
  PREVIEW_REFUSAL_CODE,
  signPrincipalHeader,
  type Context,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { PREVIEW_ACTIONS } from './preview.js';

const SECRET = 'a-quant-preview-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function signed(): Context {
  const raw = encodePrincipal({
    sub: ACCOUNT,
    userId: ACCOUNT,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read'],
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return edgeContext({
    headers: {
      'x-intafaced-region': 'DE',
      [EDGE_PRINCIPAL_HEADER]: raw,
      [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    },
    id: 'req-preview',
  });
}

function anonymous(): Context {
  return edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
}

const strategies = createMemoryStrategyRepository();
const quant = createQuantRouter({ wired: false, venueVaultSet: false, limits: { maxOps: 5_000, maxSource: 8_000 }, strategies });

async function act(body: unknown, context: () => Context = signed) {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request('http://localhost/trpc/preview.act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    router: quant,
    createContext: context,
  });
  return { status: res.status, body: (await res.json()) as { error: { message: string; data: Record<string, unknown> } } };
}

describe('quant.preview.act (AL-order-01)', () => {
  const pairs = Object.entries(PREVIEW_ACTIONS).flatMap(([room, actions]) =>
    Object.entries(actions).map(([action, engine]) => ({ room, action, engine })),
  );

  it.each(pairs)('refuses $room $action with the typed Preview refusal naming $engine', async ({ room, action, engine }) => {
    const { status, body } = await act({ room, action });
    expect(status).toBe(412);
    expect(body.error.data.code).toBe('PRECONDITION_FAILED');
    expect(body.error.data.cause).toEqual({ code: PREVIEW_REFUSAL_CODE });
    expect(body.error.data.preview).toEqual({ kind: 'preview', code: PREVIEW_REFUSAL_CODE, engine, action, label: PREVIEW_LABEL });
    expect(body.error.message).toBe(`${PREVIEW_REFUSAL_CODE} — ${engine}:${action}`);
  });

  it('the tester start names the tick engine', async () => {
    const { body } = await act({ room: 'tester', action: 'start' });
    expect((body.error.data.preview as { engine: string }).engine).toBe('quant.tick_engine');
  });

  it('refuses a signed-out caller before anything else: the sign-in comes first', async () => {
    const { status, body } = await act({ room: 'editor', action: 'compile' }, anonymous);
    expect(status).toBe(401);
    expect(body.error.data.preview).toBeUndefined();
  });

  it('takes only a room and an action from the closed list: anything else is a bad request with no refusal echo', async () => {
    for (const bad of [
      { room: 'editor', action: 'start' },
      { room: 'tester', action: 'compile' },
      { room: 'ledger', action: 'compile' },
      { room: 'editor', action: 'compile', source: 'while(true){}' },
      {},
    ]) {
      const { status, body } = await act(bad);
      expect(status, JSON.stringify(bad)).toBe(400);
      expect(body.error.data.preview).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('while(true)');
    }
  });

  it('stores nothing: the account has no strategy and no run after every refused action', async () => {
    for (const { room, action } of pairs) await act({ room, action });
    await act({ room: 'editor', action: 'compile' });
    expect((await strategies.list({ accountId: ACCOUNT, limit: 10, cursor: null })).strategies).toEqual([]);
    const caller = quant.createCaller(signed());
    expect(await caller.quickStart()).toEqual({ strategy: false, backtest: false, paperRun: false });
  });
});
