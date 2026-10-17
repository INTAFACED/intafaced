import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerHealth } from './health.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer } from './action-approval-consume.js';

/**
 * GET /health carries `venueHalted`, read live from the engine.
 *
 * svc-edge reads `venueHalted` from this body when MATCHING_URL is set and
 * refuses every NEW trade order with 503 `edge.venue_halt_unavailable` when it
 * is missing. The field was never on this body, so every environment with
 * MATCHING_URL set refused all new orders.
 */

const SECRET = 'matching-health-router-secret-32ch!!';

async function mount(): Promise<{ app: FastifyInstance; engine: MatchingEngine; journal: MemoryJournal }> {
  const journal = new MemoryJournal();
  const engine = new MatchingEngine({ journal, bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
  const app = Fastify({ logger: false });
  registerHealth(app, 'svc-matching', engine, journal);
  registerRoutes(app, engine, SECRET, {
    bodyBind: 'require',
    approvals: stubApprovalConsumer('ops-confirm'),
    operatorIds: new Set(['ops-1', 'ops-confirm']),
  });
  await app.ready();
  return { app, engine, journal };
}

function post(app: FastifyInstance, url: string, payloadBody: unknown) {
  const payload = JSON.stringify(payloadBody);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    payload,
  });
}

const HALT_ALL = { operatorId: 'ops-1', confirmOperatorId: 'ops-2', approvalId: 'appr-1', operationId: 'op-1' };

describe('GET /health venueHalted', () => {
  it('is false on a fresh engine and keeps the existing fields', async () => {
    const { app } = await mount();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      service: 'svc-matching',
      enabled: true,
      venueHalted: false,
      markets: 0,
      restingOrders: 0,
      journalRecords: 0,
    });
  });

  it('is true after halt-all and false again after resume-all — read live, not a constant', async () => {
    const { app, engine } = await mount();

    const halt = await post(app, '/halt-all', HALT_ALL);
    expect(halt.json()).toMatchObject({ accepted: true, halted: true });
    expect(engine.isVenueHalted).toBe(true);
    const halted = await app.inject({ method: 'GET', url: '/health' });
    expect(halted.json().venueHalted).toBe(true);
    expect(halted.json().journalRecords).toBeGreaterThan(0);

    const resume = await post(app, '/resume-all', HALT_ALL);
    expect(resume.json()).toMatchObject({ accepted: true, halted: false });
    const open = await app.inject({ method: 'GET', url: '/health' });
    expect(open.json().venueHalted).toBe(false);
  });

  it('agrees with GET /markets, the board svc-execution and svc-ws read', async () => {
    const { app } = await mount();
    await post(app, '/halt-all', HALT_ALL);
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    const board = (await app.inject({ method: 'GET', url: '/markets' })).json();
    expect(board.venueHalted).toBe(true);
    expect(health.venueHalted).toBe(board.venueHalted);
  });
});

describe('the deployed entrypoint serves this /health', () => {
  it('index.ts registers it through registerHealth, not a local inline route', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
    const live = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(live).toMatch(/registerHealth\(\s*app\s*,\s*env\.SERVICE_NAME\s*,\s*engine\s*,\s*journal\s*\)/);
    expect(live).not.toMatch(/app\.get\(\s*['"]\/health['"]/);
  });
});
