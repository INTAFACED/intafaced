import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  signPrincipalHeader,
  type QuantSignalRules,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryTemplateRepository } from './memory-repository.js';

const SECRET = 'a-quant-template-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const RULES: QuantSignalRules = {
  symbol: 'BTC/USDT',
  barSize: '1h',
  signal: { kind: 'ma_cross', average: 'sma', fast: '', slow: '' },
  sizing: { kind: 'percent_equity', value: '' },
  exit: { stopLossPercent: '', takeProfitPercent: '' },
};
const publish = {
  id: 'ma-cross',
  name: 'TEST moving-average cross',
  description: 'Buys when a fast average crosses above a slow one.',
  rules: RULES,
  releaseNote: 'First version.',
  reason: 'LOCAL TEST template',
  idempotencyKey: 'template.publish:ma-cross:v1',
};

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
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
    id: `req-${userId}-${scopes.join(',')}`,
  });
}

function setup() {
  const app = createQuantRouter({
    wired: true,
    venueVaultSet: false,
    limits,
    strategies: createMemoryStrategyRepository(),
    templates: createMemoryTemplateRepository(),
  });
  return {
    a: app.createCaller(signed(ACCOUNT_A)),
    writer: app.createCaller(signed(OPERATOR, ['admin:write'])),
    anonymous: app.createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' })),
  };
}

describe('starter templates', () => {
  it('lists none until an operator publishes one, and refuses a blank page size', async () => {
    const { a } = setup();
    expect(await a.template.list({ limit: 20 })).toEqual({ templates: [], nextCursor: null });
    await expect(a.template.list({})).rejects.toThrow(/quant\.template_list_limit_unset/);
    await expect(a.template.get({ id: 'ma-cross' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('publishes versions with every number blank, replays a key, and keeps older versions readable', async () => {
    const { a, writer } = setup();
    const v1 = await writer.ops.template.publish(publish);
    expect(v1).toMatchObject({ id: 'ma-cross', version: 1, rules: RULES });
    expect(await writer.ops.template.publish(publish)).toEqual(v1);
    await expect(writer.ops.template.publish({ ...publish, name: 'Another' })).rejects.toThrow(/quant\.idempotency_conflict/);
    const v2 = await writer.ops.template.publish({
      ...publish,
      rules: { ...RULES, signal: { ...RULES.signal, average: 'ema' } },
      releaseNote: 'Uses an exponential average.',
      idempotencyKey: 'template.publish:ma-cross:v2',
    });
    expect(v2.version).toBe(2);

    const listed = await a.template.list({ limit: 20 });
    expect(listed.templates.map((row) => [row.id, row.version])).toEqual([['ma-cross', 2]]);
    const detail = await a.template.get({ id: 'ma-cross' });
    expect(detail.versions.map((row) => [row.version, row.releaseNote])).toEqual([
      [2, 'Uses an exponential average.'],
      [1, 'First version.'],
    ]);
    // Each version reads with its own source (AL-editor-03), every blank number named, never a number filled in.
    expect(detail.versions[0]!.source).toContain('const fast = ema(closes, /* signal.fast: blank, you set it after Use */);');
    expect(detail.versions[1]!.source).toContain('const fast = sma(closes, /* signal.fast: blank, you set it after Use */);');
    for (const row of detail.versions) {
      expect(row.source).toContain('/* sizing.value: blank, you set it after Use */');
      expect(row.source).toContain('// Optional, blank in the template: exit.stopLossPercent, exit.takeProfitPercent.');
      expect(row.source).not.toMatch(/\(closes, \d/);
    }
  });

  it('refuses a template that sets a number, and anyone without the operator scope', async () => {
    const { a, writer, anonymous } = setup();
    await expect(writer.ops.template.publish({ ...publish, rules: { ...RULES, signal: { ...RULES.signal, fast: '10' } } })).rejects.toThrow(
      /quant\.template_number_set — signal\.fast is set/,
    );
    await expect(
      writer.ops.template.publish({ ...publish, rules: { ...RULES, sizing: { kind: 'quantity', value: '1' } } }),
    ).rejects.toThrow(/sizing\.value is set/);
    await expect(
      writer.ops.template.publish({ ...publish, rules: { ...RULES, exit: { ...RULES.exit, stopLossPercent: '  ' } } }),
    ).rejects.toThrow(/exit\.stopLossPercent is set/);
    await expect(a.ops.template.publish(publish)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(anonymous.template.list({ limit: 1 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('pages in id order', async () => {
    const { a, writer } = setup();
    for (const id of ['c-three', 'a-one', 'b-two']) {
      await writer.ops.template.publish({ ...publish, id, idempotencyKey: `template.publish:${id}:v1` });
    }
    const first = await a.template.list({ limit: 2 });
    expect(first.templates.map((row) => row.id)).toEqual(['a-one', 'b-two']);
    const second = await a.template.list({ limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.templates.map((row) => row.id)).toEqual(['c-three']);
  });

  it('withdraws a template from the list and restores it with the same versions; replays a key; refuses a stranger', async () => {
    const { a, writer } = setup();
    await writer.ops.template.publish(publish);
    await writer.ops.template.publish({ ...publish, releaseNote: 'Second.', idempotencyKey: 'template.publish:ma-cross:v2' });
    const withdraw = { id: 'ma-cross', listed: false, reason: 'LOCAL TEST withdraw', idempotencyKey: 'template.listing:ma-cross:1' };

    const off = await writer.ops.template.listing(withdraw);
    expect(off).toMatchObject({ id: 'ma-cross', listed: false });
    // The list holds nothing and the template reads as not found: it is not published, its versions are kept.
    expect(await a.template.list({ limit: 5 })).toEqual({ templates: [], nextCursor: null });
    await expect(a.template.get({ id: 'ma-cross' })).rejects.toThrow(/template not found/);
    // A replay returns the first answer; the same key for another change is a conflict.
    expect(await writer.ops.template.listing(withdraw)).toEqual(off);
    await expect(writer.ops.template.listing({ ...withdraw, listed: true })).rejects.toThrow(/different listing change/);

    await writer.ops.template.listing({ ...withdraw, listed: true, idempotencyKey: 'template.listing:ma-cross:2' });
    const back = await a.template.list({ limit: 5 });
    expect(back.templates.map((row) => [row.id, row.version])).toEqual([['ma-cross', 2]]);
    expect((await a.template.get({ id: 'ma-cross' })).versions.map((row) => row.version)).toEqual([2, 1]);

    await expect(
      writer.ops.template.listing({ ...withdraw, id: 'never-published', idempotencyKey: 'template.listing:none' }),
    ).rejects.toThrow(/template not found/);
    await expect(a.ops.template.listing({ ...withdraw, idempotencyKey: 'template.listing:user' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
