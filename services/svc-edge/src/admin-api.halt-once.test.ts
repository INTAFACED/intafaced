import { describe, expect, it } from 'vitest';
import { actionApprovalConsumeInputSchema, actionApprovalSchema } from '@intafaced/contracts';
import { createAdminApi } from './admin-api.js';
import type { ActionApprovalConsumer } from './action-approval-consume.js';
import { KillSwitchState } from './kill-switch.js';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';

describe('F1507 overlapping apply() must report changed once', () => {
  it('only one of two overlapping identical halts reports changed=true', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const approvals: ActionApprovalConsumer = {
      async consume(input) {
        await gate;
        const parsed = actionApprovalConsumeInputSchema.parse(input);
        return actionApprovalSchema.parse({
          ...parsed,
          actionType: parsed.targetId,
          requesterId: 'requester',
          approverId: CONFIRM,
          policyVersion: 'v1',
          createdAt: '2026-09-09T12:00:00.000Z',
          expiresAt: '2026-09-09T12:10:00.000Z',
          status: 'CONSUMED',
        });
      },
    };
    const state = new KillSwitchState();
    const admin = createAdminApi(state, { tokens: {} as never, ledger: null, approvals });
    const body = { module: 'trade', disabled: true, reason: 'stale prices on the book', approvalId: 'appr-1', operationId: 'op-1' };
    const operator = { userId: OPERATOR } as never;
    const a = admin.apply(body, operator);
    const b = admin.apply(body, operator);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.changed, rb.changed].filter(Boolean)).toHaveLength(1);
  });
});
