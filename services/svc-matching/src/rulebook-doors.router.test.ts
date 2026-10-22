import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { MISSING_EVIDENCE, installRulebookRefuse } from './engine/rulebook-refuse.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

/**
 * The emergency doors with the rulebook installed, as index.ts runs them. The rulebook refuses an emergency action
 * without evidence; each door's evidence is the two-person approval it consumed. Before that was passed, every halt,
 * resume, halt-all, resume-all and expire through a door was refused `missing_evidence`, so no operator could halt a
 * market (J-cex-spot-02 step 8 in the running app).
 */
installRulebookRefuse();

const SECRET = 'matching-rulebook-doors-secret-32chars!';
const EDGE_SECRET = 'edge-principal-secret-at-least-32-characters';
const REGION = 'XX';
const MARKET = 'BTC-USDT';
const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';

async function mount(): Promise<{ app: FastifyInstance; engine: MatchingEngine }> {
  const engine = new MatchingEngine({ journal: new MemoryJournal(), bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, {
    approvals: stubApprovalConsumer(CONFIRM, OPERATOR),
    operatorIds: new Set([OPERATOR, CONFIRM]),
    edgePrincipalSecret: EDGE_SECRET,
  });
  await app.ready();
  return { app, engine };
}

function signed(app: FastifyInstance, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    payload,
  });
}

const approved = (n: number) => ({ operatorId: OPERATOR, approvalId: `appr-${n}`, operationId: `op-${n}` });

describe('emergency doors with the rulebook installed', () => {
  it('the engine itself still refuses a halt without evidence', async () => {
    const { app, engine } = await mount();
    const halt = await engine.halt(MARKET, { operatorId: OPERATOR, confirmOperatorId: CONFIRM });
    expect(halt.rejected?.code).toBe(MISSING_EVIDENCE);
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });

  it('halt and resume one market through the signed door, on a consumed two-person approval', async () => {
    const { app, engine } = await mount();
    const spy = vi.spyOn(engine, 'halt');
    const halt = await signed(app, `/markets/${MARKET}/halt`, approved(1));
    // The evidence is the approval this door consumed, by its id; nothing typed in the body.
    expect(spy).toHaveBeenCalledWith(MARKET, expect.objectContaining({ evidenceRefs: ['action-approval:appr-1'] }));
    expect(halt.statusCode).toBe(200);
    expect(halt.json()).toMatchObject({ accepted: true, halted: true, operatorId: OPERATOR, confirmOperatorId: CONFIRM, rejected: null });
    expect(engine.isHalted(MARKET)).toBe(true);
    const resume = await signed(app, `/markets/${MARKET}/resume`, approved(2));
    expect(resume.json()).toMatchObject({ accepted: true, halted: false, rejected: null });
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });

  it('a refused approval halts nothing: the proposer must be the one who asks', async () => {
    const { app, engine } = await mount();
    const spy = vi.spyOn(engine, 'halt');
    const halt = await signed(app, `/markets/${MARKET}/halt`, { ...approved(7), operatorId: CONFIRM });
    expect(halt.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });

  it('halt-all and resume-all through the signed door', async () => {
    const { app, engine } = await mount();
    expect((await signed(app, '/halt-all', approved(3))).json()).toMatchObject({ accepted: true, halted: true, rejected: null });
    expect(engine.isVenueHalted).toBe(true);
    expect((await signed(app, '/resume-all', approved(4))).json()).toMatchObject({ accepted: true, halted: false, rejected: null });
    expect(engine.isVenueHalted).toBe(false);
    await app.close();
  });

  it('expire one market through the signed door', async () => {
    const { app, engine } = await mount();
    const expired = await signed(app, `/markets/${MARKET}/expire`, approved(5));
    expect(expired.json()).toMatchObject({ accepted: true, expired: true, rejected: null });
    expect(engine.isExpired(MARKET)).toBe(true);
    await app.close();
  });

  it('the founder operator door halts too', async () => {
    const { app, engine } = await mount();
    const raw = encodePrincipal({
      sub: OPERATOR,
      userId: OPERATOR,
      scopes: ['admin:write'],
      tier: 'institutional',
      mfa: true,
      sid: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/operator/halt',
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, REGION),
        'x-intafaced-region': REGION,
      },
      payload: { marketId: MARKET, approvalId: 'appr-6', operationId: 'op-6', idempotencyKey: 'halt-key-06' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, halted: true, rejected: null });
    expect(engine.isHalted(MARKET)).toBe(true);
    await app.close();
  });
});
