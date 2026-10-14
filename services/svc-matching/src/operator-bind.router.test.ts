import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { actionApprovalSchema, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { MemoryJournal } from './engine/journal.js';
import { registerRoutes } from './router.js';
import { parseOperatorIds, type ActionApprovalConsumer } from './action-approval-consume.js';

/**
 * Issue #4724. Identity lets any two users with a second factor propose and
 * approve `matching.open`. Matching is the second lock: the operatorId in the
 * body must be the person identity recorded as the requester, and both people
 * on the approval must be on the venue's operator list.
 */

const SECRET = 'matching-operator-bind-secret-32chars!';
const MARKET = 'BTC-USDT';

// Two ordinary, self-registered users (second factor on, but no operator seat).
const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
// The venue's two real operators.
const OP_A = 'cccccccc-0000-4000-8000-00000000000c';
const OP_B = 'dddddddd-0000-4000-8000-00000000000d';

/** What identity would return for an approved, unconsumed approval. */
function identityApproval(requesterId: string, approverId: string | null): ActionApprovalConsumer {
  return {
    async consume(input) {
      return actionApprovalSchema.parse({
        ...input,
        actionType: 'matching.open',
        requesterId,
        approverId,
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
      });
    },
  };
}

async function mount(approvals: ActionApprovalConsumer, operatorIds: string): Promise<{ app: FastifyInstance; engine: MatchingEngine }> {
  const engine = new MatchingEngine({ journal: new MemoryJournal(), bus: new MemoryEventBus('svc-matching'), snapshotEvery: 0 });
  const app = Fastify({ logger: false });
  registerRoutes(app, engine, SECRET, { bodyBind: 'require', approvals, operatorIds: parseOperatorIds(operatorIds) });
  await app.ready();
  return { app, engine };
}

function post(app: FastifyInstance, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', SECRET, payload) },
    payload,
  });
}

const ids = { approvalId: 'appr-1', operationId: 'op-1' };
const OPERATORS = `${OP_A}, ${OP_B.toUpperCase()}`;

async function prelaunched(approvals: ActionApprovalConsumer, operatorIds: string) {
  const mounted = await mount(approvals, operatorIds);
  await mounted.engine.prelaunch(MARKET, { operatorId: 'seed-a', confirmOperatorId: 'seed-b' });
  expect(mounted.engine.isPrelaunch(MARKET)).toBe(true);
  return mounted;
}

describe('matching.open binds the approval to operators (#4724)', () => {
  it('refuses two ordinary TOTP users who propose and approve between themselves', async () => {
    const { app, engine } = await prelaunched(identityApproval(USER_A, USER_B), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: USER_A, confirmOperatorId: USER_B, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.not_operator');
    expect(engine.isPrelaunch(MARKET)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/markets' })).json().markets).not.toContain(MARKET);
    await app.close();
  });

  it('still opens for a real operator pair, and reports the people identity recorded', async () => {
    const { app, engine } = await prelaunched(identityApproval(OP_A, OP_B), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: true, prelaunch: false, operatorId: OP_A, confirmOperatorId: OP_B });
    expect(engine.isPrelaunch(MARKET)).toBe(false);
    await app.close();
  });

  it('ignores a typed confirmOperatorId: the approver comes from identity', async () => {
    const { app } = await prelaunched(identityApproval(OP_A, OP_B), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, confirmOperatorId: 'someone-else', ...ids });
    expect(res.json()).toMatchObject({ accepted: true, confirmOperatorId: OP_B });
    await app.close();
  });

  it('refuses an operatorId that is not the approval requester, even if it names a real operator', async () => {
    const { app, engine } = await prelaunched(identityApproval(USER_A, USER_B), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, confirmOperatorId: OP_B, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.operator_not_requester');
    expect(engine.isPrelaunch(MARKET)).toBe(true);
    await app.close();
  });

  it('refuses an operator who proposed with an ordinary user as approver', async () => {
    const { app, engine } = await prelaunched(identityApproval(OP_A, USER_B), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.not_operator');
    expect(engine.isPrelaunch(MARKET)).toBe(true);
    await app.close();
  });

  it('refuses an ordinary user who proposed with an operator as approver', async () => {
    const { app } = await prelaunched(identityApproval(USER_A, OP_B), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: USER_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.not_operator');
    await app.close();
  });

  it('refuses before spending the approval when the typed requester is not an operator', async () => {
    let consumed = 0;
    const counting: ActionApprovalConsumer = {
      consume: async (input) => {
        consumed += 1;
        return identityApproval(OP_A, OP_B).consume(input);
      },
    };
    const { app } = await prelaunched(counting, OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: USER_A, ...ids });
    expect(res.json().code).toBe('action_approval.not_operator');
    expect(consumed).toBe(0);
    await app.close();
  });

  it('refuses everyone when no operator list is published', async () => {
    const { app, engine } = await prelaunched(identityApproval(OP_A, OP_B), '');
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.operators_unset');
    expect(engine.isPrelaunch(MARKET)).toBe(true);
    await app.close();
  });

  it('refuses an approval that has no distinct approver', async () => {
    const { app } = await prelaunched(identityApproval(OP_A, null), OPERATORS);
    const none = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, ...ids });
    expect(none.json().code).toBe('action_approval.missing');
    const same = await mount(identityApproval(OP_A, OP_A.toUpperCase()), OPERATORS);
    const self = await post(same.app, `/markets/${MARKET}/open`, { operatorId: OP_A, ...ids });
    expect(self.json().code).toBe('action_approval.missing');
    await app.close();
    await same.app.close();
  });

  it('binds the requester on the other approval doors too (halt)', async () => {
    const { app, engine } = await mount(identityApproval(USER_A, USER_B), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/halt`, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.operator_not_requester');
    expect(engine.isHalted(MARKET)).toBe(false);
    await app.close();
  });
});

describe('parseOperatorIds', () => {
  it('lowercases, trims and drops blanks', () => {
    expect([...parseOperatorIds(' A-1 , ,b-2,')]).toEqual(['a-1', 'b-2']);
    expect(parseOperatorIds(undefined).size).toBe(0);
    expect(parseOperatorIds('').size).toBe(0);
  });
});
