import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { FounderCallContext } from '@/lib/desk';
import { DESKS, allReads } from './catalog';
import { loadRead } from './server';

const ctx: FounderCallContext = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const read = (id: string) => allReads(DESKS.academy).find((r) => r.id === id)!;
const UNREADABLE = { kind: 'failed', message: 'svc-academy answered in a shape this console does not understand.' };
const answer = (data: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ result: { data } })),
  );
afterEach(() => vi.unstubAllGlobals());

const COUNTS = { draft: 1, published: 2, concluded: 0, archived: 0, deleted: 0 };

// A read of a call with a record never shows an answer that record refuses, where the desk columns alone would.
describe('a desk read of a call with a record parses by that record', () => {
  it("academy courses: the record's answer reads; one without the course list the record requires does not", async () => {
    answer({ courses: [], counts: COUNTS });
    expect((await loadRead(ctx, read('academy.courses'))).part.kind).toBe('ok');
    answer({ counts: COUNTS });
    expect((await loadRead(ctx, read('academy.courses'))).part).toMatchObject(UNREADABLE);
  });
  it('certificate definitions: a blank required item, which the record refuses, is unreadable', async () => {
    answer([{ id: 'cert-1', title: 'Basics', requiredItemSlugs: ['a'] }]);
    expect((await loadRead(ctx, read('academy.cert-defs'))).part.kind).toBe('ok');
    answer([{ id: 'cert-1', title: 'Basics', requiredItemSlugs: [''] }]);
    expect((await loadRead(ctx, read('academy.cert-defs'))).part).toMatchObject(UNREADABLE);
  });
});
