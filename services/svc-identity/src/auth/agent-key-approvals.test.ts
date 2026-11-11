import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { agentApprovalIdempotencyKey, holdAgentKeyAction, listAgentKeyApprovals } from './agent-key-approvals.js';

const USER = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const HASH = `sha256:${'a'.repeat(64)}`;
const input = {
  userId: USER,
  keyId: KEY,
  action: 'pay.payout' as const,
  method: 'post',
  path: '/api/pay/trpc/settlement.payout',
  bodyHash: HASH,
};
const row = {
  id: '33333333-3333-4333-8333-333333333333',
  key_id: KEY,
  key_name: 'agent-reader',
  action: 'pay.payout',
  method: 'POST',
  path: '/api/pay/trpc/settlement.payout',
  status: 'waiting',
  created_at: new Date('2026-11-09T13:00:00.000Z'),
};

function fakeSql(queue: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return queue[calls.length - 1] ?? [];
  };
  return { sql: fn as unknown as Sql, calls };
}

describe('holdAgentKeyAction (J-developer-15 #6, DV-keys-05)', () => {
  it("an agent key's attempt writes one waiting row under its business key and reads it back", async () => {
    const { sql, calls } = fakeSql([[{ kind: 'agent', name: 'agent-reader' }], [], [row]]);
    const out = await holdAgentKeyAction(sql, input);
    expect(out).toEqual({
      held: true,
      approval: {
        id: row.id,
        keyId: KEY,
        keyName: 'agent-reader',
        action: 'pay.payout',
        method: 'POST',
        path: '/api/pay/trpc/settlement.payout',
        status: 'waiting',
        createdAt: '2026-11-09T13:00:00.000Z',
      },
    });
    expect(calls[1]?.text).toContain('INSERT INTO agent_key_approvals');
    expect(calls[1]?.text).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(calls[1]?.values[0]).toBe(`agent-approval:${KEY}:pay.payout:${HASH}`);
    expect(calls[1]?.values[4]).toBe('POST');
  });

  it('the same attempt retried has the same business key; another body is another row', () => {
    expect(agentApprovalIdempotencyKey(input)).toBe(agentApprovalIdempotencyKey({ ...input, keyId: KEY.toUpperCase() }));
    expect(agentApprovalIdempotencyKey(input)).not.toBe(agentApprovalIdempotencyKey({ ...input, bodyHash: `sha256:${'b'.repeat(64)}` }));
  });

  it("a person's own key is not held, and nothing is written", async () => {
    const { sql, calls } = fakeSql([[{ kind: 'personal', name: 'desk' }]]);
    expect(await holdAgentKeyAction(sql, input)).toEqual({ held: false });
    expect(calls).toHaveLength(1);
  });

  it("a key that is not the user's live key refuses, and nothing is written", async () => {
    const { sql, calls } = fakeSql([[]]);
    await expect(holdAgentKeyAction(sql, input)).rejects.toMatchObject({ code: 'identity.key_not_found' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('revoked = false');
  });
});

describe('listAgentKeyApprovals', () => {
  it("reads only the user's rows, newest first", async () => {
    const { sql, calls } = fakeSql([[row]]);
    const out = await listAgentKeyApprovals(sql, USER, 50);
    expect(out.approvals).toHaveLength(1);
    expect(calls[0]?.text).toContain('WHERE a.user_id = ?');
    expect(calls[0]?.text).toContain('ORDER BY a.created_at DESC');
    expect(calls[0]?.values).toEqual([USER, 50]);
  });
});
