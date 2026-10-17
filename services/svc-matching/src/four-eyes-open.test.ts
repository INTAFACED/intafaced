import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { actionApprovalConsumeInputSchema, actionApprovalSchema, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';
import { stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';

/**
 * S10 / TRD-0003 / OPS-0021. Opening the book and halting a market are two people.
 * Two typed names without an approval id are not an approval. A consumed row
 * whose approver is the proposer is not an approval either.
 */

const SECRET = 'matching-four-eyes-open-secret-32ch!';
const MARKET = 'BTC-USDT';

function samePersonOpenApproval(): ActionApprovalConsumer {
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      return actionApprovalSchema.parse({
        ...parsed,
        actionType: 'matching.open',
        requesterId: 'ops-1',
        approverId: 'ops-1',
        approverIsFounder: true,
        requesterIsFounder: true,
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
      });
    },
  };
}

async function mount(approvals: ActionApprovalConsumer = stubApprovalConsumer('ops-confirm')): Promise<{
  app: FastifyInstance;
  engine: MatchingEngine;
}> {
  const engine = new MatchingEngine({
    journal: new MemoryJournal(),
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
  });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, { bodyBind: 'require', approvals });
  await app.ready();
  return { app, engine };
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

describe('S10 two people open the book', () => {
  it('refuses halt when two different names are typed and no approval id is present (OPS-0021)', async () => {
    const { app, engine } = await mount();
    const halt = await post(app, `/markets/${MARKET}/halt`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
    });
    expect(halt.statusCode).toBe(400);
    expect(halt.json().code).toBe('action_approval.missing');
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });

  it('refuses open when two different names are typed and no approval id is present', async () => {
    const { app, engine } = await mount();
    const opened = await post(app, `/markets/${MARKET}/open`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
    });
    expect(opened.statusCode).toBe(400);
    expect(opened.json().code).toBe('action_approval.missing');
    expect(engine.isListed(MARKET)).toBe(false);
    await app.close();
  });

  it('refuses open when the consumed approval is the same person who proposed it (TRD-0003)', async () => {
    const { app, engine } = await mount(samePersonOpenApproval());
    const opened = await post(app, `/markets/${MARKET}/open`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(opened.statusCode).toBe(400);
    expect(opened.json().code).toBe('action_approval.not_founders');
    expect(engine.isListed(MARKET)).toBe(false);
    await app.close();
  });

  it('opens the book when a different person approved it', async () => {
    const { app, engine } = await mount();
    const opened = await post(app, `/markets/${MARKET}/open`, {
      operatorId: 'ops-1',
      confirmOperatorId: 'ops-2',
      approvalId: 'appr-1',
      operationId: 'op-1',
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      accepted: true,
      marketId: MARKET,
      prelaunch: false,
      confirmOperatorId: 'ops-confirm',
      rejected: null,
    });
    expect(engine.isListed(MARKET)).toBe(true);
    await app.close();
  });
});
