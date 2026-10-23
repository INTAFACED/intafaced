import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { SUPPORT_FEEDBACK_RATE_EXCEEDED, readerActorId } from './kb-feedback.js';
import { SupportService } from './support-service.js';
import { PostgresSupportStore } from './store.js';

/**
 * SP-kb-03 against Postgres. One request per vote, a public rate that lets one
 * of two racing votes through, and search logs with no reader column.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = readdirSync(join(here, '..', 'drizzle'))
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(here, '..', 'drizzle', name), 'utf8'));

const USER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'browser-reader-token';

async function harnessUrl(): Promise<string | null> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !(await postgresAvailable(raw))) return null;
  const name = new URL(raw).pathname.replace(/^\//, '').split('/')[0] ?? '';
  if (name.endsWith('_test')) return raw;
  const admin = postgres(raw, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe('CREATE DATABASE adminops_harness_test');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) throw err;
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(raw);
  url.pathname = '/adminops_harness_test';
  return url.toString();
}

const url = await harnessUrl();

if (!url) {
  describe.skip('kb feedback postgres (unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDatabase = await createTestDatabase({ service: 'support', url, migrations });
  let support: SupportService;

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.truncateAll();
    support = new SupportService(
      new PostgresSupportStore(db.sql),
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      {
        feedbackRateLimit: 1,
        feedbackRateWindowSeconds: 60,
      },
    );
  });

  async function publish(id: string, tags?: string[]) {
    await support.publishKb({
      id,
      titleKey: `support.kb.${id}.title`,
      bodyKey: `support.kb.${id}.body`,
      baseRevision: 0,
      ...(tags ? { tags } : {}),
    });
  }

  describe('kb feedback postgres', () => {
    it('stores one request for an unhelpful vote and no reader column on a search log', async () => {
      const columns = await db.sql<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'support' AND table_name IN ('kb_search_misses', 'kb_search_clicks')
      `;
      const names = columns.map((row) => row.column_name);
      expect(names.some((name) => /user|reader|actor/i.test(name))).toBe(false);

      await publish('kb-fb-withdraw', ['withdrawal']);
      const vote = await support.kbFeedback({
        userId: USER,
        id: 'kb-fb-withdraw',
        helpful: false,
        comment: 'The steps did not work',
        openRequest: true,
        clientRequestId: 'fb-req-1',
      });
      const again = await support.kbFeedback({
        userId: USER,
        id: 'kb-fb-withdraw',
        helpful: false,
        comment: 'The steps did not work',
        openRequest: true,
        clientRequestId: 'fb-req-1',
      });
      expect(again).toEqual(vote);
      const tickets = await db.sql<{ n: number; body: string }[]>`
        SELECT count(*)::int AS n, min(body) AS body FROM support.tickets WHERE user_id = ${USER}
      `;
      expect(tickets[0]).toMatchObject({ n: 1 });
      expect(tickets[0]!.body).toContain('kb-fb-withdraw');

      expect(await support.searchKb('no-such-word', { limit: 10 })).toEqual([]);
      const misses = await db.sql<{ query: string; result_count: number }[]>`
        SELECT query, result_count FROM support.kb_search_misses
      `;
      expect(misses).toEqual([{ query: 'no-such-word', result_count: 0 }]);
    });

    it('lets one of two racing public votes through', async () => {
      await publish('kb-fb-a');
      await publish('kb-fb-b');
      const raced = await Promise.allSettled([
        support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-a', helpful: true, clientRequestId: 'race-1' }),
        support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-b', helpful: false, clientRequestId: 'race-2' }),
      ]);
      const ok = raced.filter((row) => row.status === 'fulfilled');
      const refused = raced.filter((row) => row.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: SUPPORT_FEEDBACK_RATE_EXCEEDED });
      const rows = await db.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM support.kb_feedback WHERE user_id = ${readerActorId(TOKEN)}
      `;
      expect(rows[0]!.n).toBe(1);
    });
  });
}
