import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, NoticeError, type NoticeApprovalConsumer } from './board.js';

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

function harness(start: string) {
  let now = new Date(start);
  const board = new NoticeBoard(new MemoryNoticeStore(), new Approvals(), new MemoryCommandLog(), () => now);
  let n = 0;
  return {
    board,
    at(iso: string) {
      now = new Date(iso);
    },
    /** Draft and publish in one step, as two different operators. */
    async publish(input: Parameters<NoticeBoard['draft']>[1]) {
      n += 1;
      const draft = await board.draft(AUTHOR, input);
      return board.publish(AUTHOR, { id: draft.id, clientRequestId: `pub-${n}`, approvalId: `appr-${n}`, operationId: `op-${n}` });
    },
  };
}

const maintenance = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: 'maintenance',
  title: 'TEST BTC/USDC maintenance',
  body: 'TEST body',
  clientRequestId: key,
  ...extra,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NoticeError) return err.code;
    throw err;
  }
  throw new Error('expected a NoticeError');
}

describe('market maintenance windows (J-cex-spot-14 #5)', () => {
  it('a maintenance notice may name a market; one an hour away is served before it starts, with its end or none', async () => {
    const h = harness('2026-11-06T09:00:00.000Z');
    const soon = await h.publish(
      maintenance('m-1', { components: ['market-btc-usdc'], startsAt: '2026-11-06T10:00:00.000Z', endsAt: '2026-11-06T11:00:00.000Z' }),
    );
    const open = await h.publish(maintenance('m-2', { components: ['market-eth-usdc', 'api'], startsAt: '2026-11-06T10:30:00.000Z' }));
    const read = await h.board.marketMaintenance();
    expect(read.windows).toEqual([
      expect.objectContaining({ id: soon.id, markets: ['market-btc-usdc'], startsAt: '2026-11-06T10:00:00.000Z', endsAt: '2026-11-06T11:00:00.000Z' }),
      expect.objectContaining({ id: open.id, markets: ['market-eth-usdc'], endsAt: null }),
    ]);
    // Once its end has passed, a window is no longer served.
    h.at('2026-11-06T11:00:00.000Z');
    expect((await h.board.marketMaintenance()).windows.map((w) => w.id)).toEqual([open.id]);
  });

  it('leaves out drafts and windows that name no market', async () => {
    const h = harness('2026-11-06T09:00:00.000Z');
    await h.board.draft(AUTHOR, maintenance('d-1', { components: ['market-btc-usdc'], startsAt: '2026-11-06T10:00:00.000Z' }));
    await h.publish(maintenance('m-3', { components: ['api'], startsAt: '2026-11-06T10:00:00.000Z' }));
    expect((await h.board.marketMaintenance()).windows).toEqual([]);
  });

  it('an incident never names a market component, and a malformed market id is unknown', async () => {
    const h = harness('2026-11-06T09:00:00.000Z');
    expect(
      await refusal(h.publish({ kind: 'incident', title: 't', body: 'b', clientRequestId: 'i-1', impact: 'minor', components: ['market-btc-usdc'] })),
    ).toBe('notify.notice_component_unknown');
    expect(await refusal(h.publish(maintenance('m-4', { components: ['market-btc'] })))).toBe('notify.notice_component_unknown');
  });
});
