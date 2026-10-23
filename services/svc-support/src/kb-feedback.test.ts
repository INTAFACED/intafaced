import { describe, expect, it } from 'vitest';
import { SupportError, SupportService } from './support-service.js';
import {
  SUPPORT_ASSISTANT_MODEL_UNSET,
  SUPPORT_FEEDBACK_RATE_EXCEEDED,
  SUPPORT_FEEDBACK_RATE_LIMIT_UNSET,
  SUPPORT_FEEDBACK_REQUEST_INVALID,
  SUPPORT_SEARCH_QUERY_TOO_LONG,
} from './kb-feedback.js';

/**
 * SP-kb-03. An unhelpful vote with a comment opens one request that names the
 * article. A blank public rate stores nothing. J-support-public-01 steps 4 and 8.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'browser-reader-token';

function clocked(kb: {
  feedbackRateLimit?: number | null;
  feedbackRateWindowSeconds?: number | null;
  assistantModel?: string | null;
  searchQueryMax?: number | null;
}) {
  let now = new Date('2026-10-23T00:00:00.000Z');
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    () => now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    kb,
  );
  return {
    support,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function publish(support: SupportService, id: string, tags?: string[]) {
  await support.publishKb({
    id,
    titleKey: `support.kb.${id}.title`,
    bodyKey: `support.kb.${id}.body`,
    baseRevision: 0,
    ...(tags ? { tags } : {}),
  });
}

describe('article feedback and search logs (SP-kb-03)', () => {
  it('opens one request from an unhelpful vote and a replay does not open another', async () => {
    const { support } = clocked({});
    await publish(support, 'kb-fb-withdraw', ['withdrawal']);
    const vote = await support.kbFeedback({
      userId: USER,
      id: 'kb-fb-withdraw',
      helpful: false,
      comment: 'The steps did not work',
      openRequest: true,
      clientRequestId: 'fb-req-1',
    });
    expect(vote.ticketId).toEqual(expect.any(String));
    const ticket = await support.getTicket({ userId: USER, ticketId: vote.ticketId! });
    expect(ticket.body).toContain('kb-fb-withdraw');
    expect(ticket.body).toContain('The steps did not work');
    expect(ticket.category).toBe('other');

    const replay = await support.kbFeedback({
      userId: USER,
      id: 'kb-fb-withdraw',
      helpful: true,
      comment: 'different',
      openRequest: true,
      clientRequestId: 'fb-req-1',
    });
    expect(replay).toEqual(vote);
    const second = await support.kbFeedback({
      userId: USER,
      id: 'kb-fb-withdraw',
      helpful: false,
      comment: 'once more',
      openRequest: true,
      clientRequestId: 'fb-req-2',
    });
    expect(second.ticketId).toBe(vote.ticketId);
    expect(await support.listMyTickets({ userId: USER, limit: 10 })).toHaveLength(1);
    expect(await support.kbFeedbackSummary({ limit: 10 })).toEqual([{ articleId: 'kb-fb-withdraw', version: 1, helpful: 0, unhelpful: 1 }]);
  });

  it('refuses a request that is not an unhelpful vote with a comment, and stores nothing', async () => {
    const { support } = clocked({});
    await publish(support, 'kb-fb-plain');
    await expect(
      support.kbFeedback({ userId: USER, id: 'kb-fb-plain', helpful: true, comment: 'nice', openRequest: true, clientRequestId: 'bad-1' }),
    ).rejects.toMatchObject({ code: SUPPORT_FEEDBACK_REQUEST_INVALID });
    await expect(
      support.kbFeedback({ userId: USER, id: 'kb-fb-plain', helpful: false, openRequest: true, clientRequestId: 'bad-2' }),
    ).rejects.toMatchObject({ code: SUPPORT_FEEDBACK_REQUEST_INVALID });
    expect(await support.listMyTickets({ userId: USER, limit: 10 })).toEqual([]);
    expect(await support.kbFeedbackSummary({ limit: 10 })).toEqual([]);
  });

  it('refuses a public vote while the rate is blank, and stores nothing', async () => {
    const { support } = clocked({});
    await publish(support, 'kb-fb-public');
    await expect(
      support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-public', helpful: false, clientRequestId: 'pub-1' }),
    ).rejects.toBeInstanceOf(SupportError);
    await expect(
      support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-public', helpful: false, clientRequestId: 'pub-1' }),
    ).rejects.toMatchObject({ code: SUPPORT_FEEDBACK_RATE_LIMIT_UNSET });
    expect(await support.kbFeedbackSummary({ limit: 10 })).toEqual([]);
  });

  it('allows one public vote inside the window and a later one after it', async () => {
    const { support, advance } = clocked({ feedbackRateLimit: 1, feedbackRateWindowSeconds: 60 });
    await publish(support, 'kb-fb-a');
    await publish(support, 'kb-fb-b');
    const first = await support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-a', helpful: true, clientRequestId: 'pub-a' });
    expect(first).toEqual({ articleId: 'kb-fb-a', version: 1, helpful: true });
    await expect(
      support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-b', helpful: false, clientRequestId: 'pub-b' }),
    ).rejects.toMatchObject({ code: SUPPORT_FEEDBACK_RATE_EXCEEDED });
    expect(await support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-a', helpful: false, clientRequestId: 'pub-a2' })).toEqual(first);
    advance(61_000);
    const later = await support.kbFeedbackPublic({ readerToken: TOKEN, id: 'kb-fb-b', helpful: false, clientRequestId: 'pub-b2' });
    expect(later.articleId).toBe('kb-fb-b');
  });

  it('logs a miss with no reader, records one click, and refuses a blank answer model', async () => {
    const { support } = clocked({});
    await publish(support, 'kb-fb-withdraw', ['withdrawal']);
    expect(await support.searchKb('no-such-word', { limit: 10 })).toEqual([]);
    const misses = await support.kbSearchMisses({ limit: 10 });
    expect(misses).toHaveLength(1);
    expect(misses[0]).toMatchObject({ query: 'no-such-word', resultCount: 0 });
    expect(Object.keys(misses[0]!).sort()).toEqual(['at', 'query', 'resultCount']);

    expect(await support.kbSearchClick({ articleId: 'kb-fb-withdraw', query: 'withdrawal', clientRequestId: 'click-1' })).toEqual({
      recorded: true,
    });
    expect(await support.kbSearchClick({ articleId: 'missing', query: 'withdrawal', clientRequestId: 'click-1' })).toEqual({
      recorded: true,
    });
    expect(await support.kbSearchClick({ articleId: 'missing', query: 'withdrawal', clientRequestId: 'click-2' })).toEqual({
      recorded: false,
    });

    await expect(support.kbAnswer('withdrawal', { limit: 10 })).rejects.toMatchObject({ code: SUPPORT_ASSISTANT_MODEL_UNSET });
    const ranked = clocked({ assistantModel: 'owner-switched-on', searchQueryMax: 12 });
    await publish(ranked.support, 'kb-fb-withdraw', ['withdrawal']);
    const answer = await ranked.support.kbAnswer('withdrawal', { limit: 10 });
    expect(JSON.stringify(answer)).not.toContain('owner-switched-on');
    expect(answer.sources.some((row) => row.id === 'kb-fb-withdraw')).toBe(true);
    await expect(ranked.support.searchKb('withdrawal-is-too-long', { limit: 10 })).rejects.toMatchObject({
      code: SUPPORT_SEARCH_QUERY_TOO_LONG,
    });
    expect(await ranked.support.kbSearchMisses({ limit: 10 })).toEqual([]);
  });
});
