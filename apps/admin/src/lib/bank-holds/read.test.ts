import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const calls: { procedure: string; input: unknown }[] = [];
vi.mock('@/lib/desk/founder-call', () => ({
  founderCall: async (_ctx: unknown, _module: string, procedure: string, _method: string, input: unknown) => {
    calls.push({ procedure, input });
    return { kind: 'unavailable', uncertain: false, requestId: null };
  },
}));

describe('readHoldDesk', () => {
  it('asks for the queue with an explicit limit, since the service refuses a list without one', async () => {
    const { readHoldDesk, QUEUE_LIMIT } = await import('./read');
    const desk = await readHoldDesk({} as never);
    expect(calls.find((c) => c.procedure === 'global.ops.holds')?.input).toEqual({ limit: QUEUE_LIMIT });
    expect(QUEUE_LIMIT).toBeLessThanOrEqual(100);
    expect(desk.queue.kind).toBe('failed');
    expect(desk.controls.kind).toBe('failed');
  });
});
