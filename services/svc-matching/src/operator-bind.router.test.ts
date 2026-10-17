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
function identityApproval(requesterId: string, approverId: string | null, over: Record<string, unknown> = {}): ActionApprovalConsumer {
  return {
    async consume(input) {
      return actionApprovalSchema.parse({
        ...input,
        // Identity returns the label the proposer typed. Honest by default.
        actionType: `matching.${input.targetId.split(':')[0]}`,
        requesterId,
        approverId,
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
        // #4790: a matching.* approval carries a founder attestation unless the test strips it.
        approverIsFounder: true,
        requesterIsFounder: true,
        ...over,
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

  it('refuses when the body names the other operator instead of the requester', async () => {
    // Both people are operators and attested founders. Without the requester bind this open succeeds.
    const { app, engine } = await prelaunched(identityApproval(OP_B, OP_A), OPERATORS);
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.operator_not_requester');
    expect(engine.isPrelaunch(MARKET)).toBe(true);
    await app.close();
  });

  it('refuses opening when identity did not attest a founder pair', async () => {
    const { app, engine } = await prelaunched(
      identityApproval(OP_A, OP_B, { approverIsFounder: false, requesterIsFounder: false }),
      OPERATORS,
    );
    const res = await post(app, `/markets/${MARKET}/open`, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.not_founders');
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

/** Every approval-gated door: route, the action it consumes, and the approval target it consumes. */
const DOORS = [
  { route: `/markets/${MARKET}/halt`, action: 'matching.halt', target: `halt:${MARKET}` },
  { route: `/markets/${MARKET}/resume`, action: 'matching.resume', target: `resume:${MARKET}` },
  { route: '/halt-all', action: 'matching.halt_all', target: 'halt_all' },
  { route: '/resume-all', action: 'matching.resume_all', target: 'resume_all' },
  { route: `/markets/${MARKET}/reduce-only`, action: 'matching.reduce_only', target: `reduce_only:${MARKET}` },
  { route: `/markets/${MARKET}/reduce-only/resume`, action: 'matching.reduce_only_resume', target: `reduce_only_resume:${MARKET}` },
  { route: `/markets/${MARKET}/post-only`, action: 'matching.post_only', target: `post_only:${MARKET}` },
  { route: `/markets/${MARKET}/post-only/resume`, action: 'matching.post_only_resume', target: `post_only_resume:${MARKET}` },
  { route: `/markets/${MARKET}/prelaunch`, action: 'matching.prelaunch', target: `prelaunch:${MARKET}` },
  { route: `/markets/${MARKET}/open`, action: 'matching.open', target: `open:${MARKET}` },
  { route: `/markets/${MARKET}/expire`, action: 'matching.expire', target: `expire:${MARKET}` },
  { route: `/markets/${MARKET}/delist`, action: 'matching.delist', target: `delist:${MARKET}` },
] as const;

describe.each(DOORS)('$action door ($route)', ({ route, action, target }) => {
  it('refuses two ordinary users', async () => {
    const { app } = await mount(identityApproval(USER_A, USER_B), OPERATORS);
    const res = await post(app, route, { operatorId: USER_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.not_operator');
    await app.close();
  });

  it('refuses an operator proposer whose approver is an ordinary user', async () => {
    const { app } = await mount(identityApproval(OP_A, USER_B), OPERATORS);
    const res = await post(app, route, { operatorId: OP_A, ...ids });
    expect(res.json().code).toBe('action_approval.not_operator');
    await app.close();
  });

  it('refuses everyone when no operator list is published', async () => {
    const { app } = await mount(identityApproval(OP_A, OP_B), '');
    const res = await post(app, route, { operatorId: OP_A, ...ids });
    expect(res.json().code).toBe('action_approval.operators_unset');
    await app.close();
  });

  it('refuses an approval labelled for a different action', async () => {
    const other = action === 'matching.halt' ? 'matching.resume' : 'matching.halt';
    const { app } = await mount(identityApproval(OP_A, OP_B, { actionType: other }), OPERATORS);
    const res = await post(app, route, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('action_approval.wrong_action');
    await app.close();
  });

  it('refuses an approval for a different target', async () => {
    const { app } = await mount(identityApproval(OP_A, OP_B, { targetId: `${target}:other` }), OPERATORS);
    const res = await post(app, route, { operatorId: OP_A, ...ids });
    expect(res.json().code).toBe('action_approval.wrong_action');
    await app.close();
  });

  it('refuses an approval for a different service', async () => {
    const { app } = await mount(identityApproval(OP_A, OP_B, { targetService: 'svc-trade' }), OPERATORS);
    const res = await post(app, route, { operatorId: OP_A, ...ids });
    expect(res.json().code).toBe('action_approval.wrong_action');
    await app.close();
  });

  it('refuses an approval that is not in the consumed state', async () => {
    const { app } = await mount(identityApproval(OP_A, OP_B, { status: 'APPROVED' }), OPERATORS);
    const res = await post(app, route, { operatorId: OP_A, ...ids });
    expect(res.json().code).toBe('action_approval.wrong_action');
    await app.close();
  });

  it('lets a real operator pair through with an honest approval', async () => {
    const { app } = await mount(identityApproval(OP_A, OP_B), OPERATORS);
    const res = await post(app, route, { operatorId: OP_A, ...ids });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ operatorId: OP_A, confirmOperatorId: OP_B });
    await app.close();
  });
});

describe('parseOperatorIds', () => {
  it('lowercases, trims and drops blanks', () => {
    expect([...parseOperatorIds(' A-1 , ,b-2,')]).toEqual(['a-1', 'b-2']);
    expect([...parseOperatorIds('x ,\t y\n,z')]).toEqual(['x', 'y', 'z']);
    expect(parseOperatorIds(undefined).size).toBe(0);
    expect(parseOperatorIds('').size).toBe(0);
  });
});
