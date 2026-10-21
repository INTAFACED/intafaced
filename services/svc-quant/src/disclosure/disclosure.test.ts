import { describe, expect, it } from 'vitest';
import {
  createEdgeContext,
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  encodePrincipal,
  quantDisclosureAcceptKey,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { createQuantRouter } from '../router.js';
import { createMemoryStrategyRepository } from '../studio/memory-repository.js';
import { createMemoryDisclosureRepository } from './memory-repository.js';

const SECRET = 'a-quant-disclosure-test-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-quant' });
const limits = { maxOps: 5_000, maxSource: 8_000 };
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const body = {
  name: 'alpha',
  blocks: [{ side: 'buy' as const, symbol: 'BTC-USD', qty: '0.01' }],
  risk: { maxDrawdown: '500', maxNotional: '10000', kill: '100' },
  cash: '10000',
  environment: 'paper' as const,
};

function signed(userId: string, scopes: string[] = ['trade:read']) {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic' as const,
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } satisfies Parameters<typeof encodePrincipal>[0];
  const raw = encodePrincipal(principal);
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
    disclosure: createMemoryDisclosureRepository(),
  });
  return {
    a: app.createCaller(signed(ACCOUNT_A)),
    b: app.createCaller(signed(ACCOUNT_B)),
    writer: app.createCaller(signed(OPERATOR, ['admin:write'])),
    reader: app.createCaller(signed(OPERATOR, ['admin:read'])),
    anonymous: app.createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' })),
  };
}

const WORDING = 'Wording supplied by the owner in this test.';

describe('risk disclosure', () => {
  it('says unpublished when nothing was published and refuses to record an acceptance', async () => {
    const { a } = setup();
    const saved = await a.studio.save({ ...body, clientStrategyId: 'c1', idempotencyKey: 'k-save' });
    expect(await a.disclosure.current()).toEqual({ published: false });
    const status = await a.disclosure.status({ strategyId: saved.id, strategyVersion: 1 });
    expect(status).toMatchObject({ disclosure: { published: false }, accepted: false, acceptedAt: null });
    await expect(a.disclosure.accept({ strategyId: saved.id, strategyVersion: 1, disclosureVersion: 1 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('quant.disclosure_unset'),
    });
  });

  it('publishes versions in order and replays a publish under its key', async () => {
    const { writer, a } = setup();
    const first = await writer.ops.disclosure.publish({ text: WORDING, reason: 'first wording', idempotencyKey: 'pub-1' });
    expect(first.version).toBe(1);
    expect(await writer.ops.disclosure.publish({ text: WORDING, reason: 'first wording', idempotencyKey: 'pub-1' })).toEqual(first);
    await expect(writer.ops.disclosure.publish({ text: 'other', reason: 'x', idempotencyKey: 'pub-1' })).rejects.toMatchObject({
      message: expect.stringContaining('quant.idempotency_conflict'),
    });
    const second = await writer.ops.disclosure.publish({ text: `${WORDING} v2`, reason: 'second wording', idempotencyKey: 'pub-2' });
    expect(second.version).toBe(2);
    expect(await a.disclosure.current()).toMatchObject({ published: true, version: 2, text: `${WORDING} v2` });
  });

  it('records one acceptance per strategy version and disclosure version, and needs a new one after either changes', async () => {
    const { a, writer } = setup();
    const saved = await a.studio.save({ ...body, clientStrategyId: 'c1', idempotencyKey: 'k-save' });
    await writer.ops.disclosure.publish({ text: WORDING, reason: 'r', idempotencyKey: 'pub-1' });

    const accepted = await a.disclosure.accept({ strategyId: saved.id, strategyVersion: 1, disclosureVersion: 1 });
    expect(accepted.key).toBe(quantDisclosureAcceptKey(saved.id, 1, 1));
    const again = await a.disclosure.accept({ strategyId: saved.id, strategyVersion: 1, disclosureVersion: 1 });
    expect(again).toEqual(accepted);
    expect(await a.disclosure.status({ strategyId: saved.id, strategyVersion: 1 })).toMatchObject({
      accepted: true,
      acceptedAt: accepted.acceptedAt,
    });

    await a.studio.update({ ...body, id: saved.id, name: 'beta', idempotencyKey: 'k-rev' });
    expect(await a.disclosure.status({ strategyId: saved.id, strategyVersion: 2 })).toMatchObject({ accepted: false, acceptedAt: null });
    expect(await a.disclosure.status({ strategyId: saved.id, strategyVersion: 1 })).toMatchObject({ accepted: true });

    await writer.ops.disclosure.publish({ text: `${WORDING} v2`, reason: 'r2', idempotencyKey: 'pub-2' });
    expect(await a.disclosure.status({ strategyId: saved.id, strategyVersion: 1 })).toMatchObject({ accepted: false, acceptedAt: null });
    await expect(a.disclosure.accept({ strategyId: saved.id, strategyVersion: 1, disclosureVersion: 1 })).rejects.toMatchObject({
      message: expect.stringContaining('quant.disclosure_version_stale'),
    });
  });

  it("treats another account's strategy, a missing version and a deleted strategy as not found", async () => {
    const { a, b, writer } = setup();
    const saved = await a.studio.save({ ...body, clientStrategyId: 'c1', idempotencyKey: 'k-save' });
    await writer.ops.disclosure.publish({ text: WORDING, reason: 'r', idempotencyKey: 'pub-1' });
    const missing = { code: 'NOT_FOUND', message: expect.stringContaining('quant.studio_not_found') };
    await expect(b.disclosure.accept({ strategyId: saved.id, strategyVersion: 1, disclosureVersion: 1 })).rejects.toMatchObject(missing);
    await expect(b.disclosure.status({ strategyId: saved.id, strategyVersion: 1 })).rejects.toMatchObject(missing);
    await expect(a.disclosure.accept({ strategyId: saved.id, strategyVersion: 9, disclosureVersion: 1 })).rejects.toMatchObject(missing);
    await a.studio.delete({ id: saved.id, idempotencyKey: 'k-del' });
    await expect(a.disclosure.accept({ strategyId: saved.id, strategyVersion: 1, disclosureVersion: 1 })).rejects.toMatchObject(missing);
  });

  it('keeps two accounts apart even when they accept the same ids', async () => {
    const { a, b, writer } = setup();
    await writer.ops.disclosure.publish({ text: WORDING, reason: 'r', idempotencyKey: 'pub-1' });
    const one = await a.studio.save({ ...body, clientStrategyId: 'c1', idempotencyKey: 'k-a' });
    await a.disclosure.accept({ strategyId: one.id, strategyVersion: 1, disclosureVersion: 1 });
    const two = await b.studio.save({ ...body, clientStrategyId: 'c1', idempotencyKey: 'k-b' });
    expect(await b.disclosure.status({ strategyId: two.id, strategyVersion: 1 })).toMatchObject({ accepted: false });
  });

  it('refuses anonymous callers and keeps the operator calls behind admin scopes', async () => {
    const { anonymous, a, reader } = setup();
    await expect(anonymous.disclosure.current()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(a.ops.disclosure.publish({ text: 'x', reason: 'y', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(a.ops.disclosure.counts()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reader.ops.disclosure.publish({ text: 'x', reason: 'y', idempotencyKey: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('counts acceptances per version with no accounts, strategies or wording', async () => {
    const { a, writer, reader } = setup();
    await writer.ops.disclosure.publish({ text: WORDING, reason: 'r', idempotencyKey: 'pub-1' });
    const saved = await a.studio.save({ ...body, clientStrategyId: 'c1', idempotencyKey: 'k-save' });
    await a.disclosure.accept({ strategyId: saved.id, strategyVersion: 1, disclosureVersion: 1 });
    const counts = await reader.ops.disclosure.counts();
    expect(counts.versions).toEqual([{ version: 1, publishedAt: expect.any(String), acceptances: 1 }]);
    expect(JSON.stringify(counts)).not.toContain(WORDING);
    expect(JSON.stringify(counts)).not.toContain(ACCOUNT_A);
    expect(JSON.stringify(counts)).not.toContain(saved.id);
  });

  it('refuses by naming the missing database when no store is passed', async () => {
    const app = createQuantRouter({ wired: true, venueVaultSet: false, limits });
    const a = app.createCaller(signed(ACCOUNT_A));
    await expect(a.disclosure.current()).rejects.toMatchObject({ message: expect.stringContaining('quant.database_url_unset') });
  });
});
