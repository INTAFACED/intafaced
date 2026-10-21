import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { deskCopy } from './support-desk-copy';
import {
  attachFile,
  closeRequest,
  downloadFile,
  rateRequest,
  readAttachLimits,
  readRating,
  readRelated,
  readTicketFiles,
  sendArticleFeedback,
} from './support-calls';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const T1 = '22222222-2222-4222-8222-222222222222';
const T2 = '33333333-3333-4333-8333-333333333333';
const ticket = (over: Record<string, unknown> = {}) => ({
  id: T1,
  userId: ME,
  category: 'account',
  subject: 'Cannot sign in',
  body: 'Help',
  status: 'closed',
  assigneeId: null,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T01:00:00.000Z',
  ...over,
});
const rating = (over: Record<string, unknown> = {}) => ({
  ticketId: T1,
  userId: ME,
  score: 4,
  note: null,
  createdAt: '2026-10-17T02:00:00.000Z',
  ...over,
});

function harness(reply: () => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const api = createApiClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return reply();
    },
  });
  return { api, calls };
}
const ok = (data: unknown) => () => new Response(JSON.stringify({ result: { data } }));
const refused = (status: number, message: string, code: string) => () =>
  new Response(JSON.stringify({ error: { message, data: { code } } }), { status });

describe('close', () => {
  it('calls support.close with the ticket and its request id, and believes only a closed ticket of this account', async () => {
    const { api, calls } = harness(ok(ticket()));
    const result = await closeRequest(api, { ticketId: T1, userId: ME, clientRequestId: 'close:a' });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ url: '/api/support/trpc/close', method: 'POST', body: { ticketId: T1, clientRequestId: 'close:a' } }]);
  });

  it.each([
    ['another ticket', ticket({ id: T2 })],
    ['another account', ticket({ userId: OTHER })],
    ['a ticket that is not closed', ticket({ status: 'open' })],
  ])('does not believe an answer about %s', async (_name, answer) => {
    const { api } = harness(ok(answer));
    const result = await closeRequest(api, { ticketId: T1, userId: ME, clientRequestId: 'close:a' });
    expect(result).toMatchObject({ ok: false, reason: 'uncertain' });
  });

  it('says plainly when the request is already closed', async () => {
    const { api } = harness(refused(412, 'support.transition_same_status', 'PRECONDITION_FAILED'));
    expect(await closeRequest(api, { ticketId: T1, userId: ME, clientRequestId: 'close:a' })).toMatchObject({
      ok: false,
      message: deskCopy.t('refuseAlreadyClosed'),
    });
  });
});

describe('rate', () => {
  it('sends the score, the trimmed note and the request id', async () => {
    const { api, calls } = harness(ok(rating({ note: 'Thanks' })));
    const result = await rateRequest(api, { ticketId: T1, userId: ME, score: 4, note: '  Thanks ', clientRequestId: 'rate:a' });
    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual({
      url: '/api/support/trpc/rate',
      method: 'POST',
      body: { ticketId: T1, score: 4, note: 'Thanks', clientRequestId: 'rate:a' },
    });
  });

  it('leaves the note out when it is blank', async () => {
    const { api, calls } = harness(ok(rating()));
    await rateRequest(api, { ticketId: T1, userId: ME, score: 4, note: '   ', clientRequestId: 'rate:a' });
    expect(calls[0]!.body).toEqual({ ticketId: T1, score: 4, clientRequestId: 'rate:a' });
  });

  it('does not believe a rating with a different score or owner', async () => {
    for (const answer of [rating({ score: 1 }), rating({ userId: OTHER }), rating({ ticketId: T2 })]) {
      const { api } = harness(ok(answer));
      expect(await rateRequest(api, { ticketId: T1, userId: ME, score: 4, note: '', clientRequestId: 'rate:a' })).toMatchObject({
        ok: false,
      });
    }
  });

  it('says plainly that a request is rated once, and only after it is resolved', async () => {
    const twice = harness(refused(409, 'support.already_rated', 'CONFLICT'));
    expect(await rateRequest(twice.api, { ticketId: T1, userId: ME, score: 4, note: '', clientRequestId: 'rate:a' })).toMatchObject({
      message: deskCopy.t('refuseAlreadyRated'),
    });
    const early = harness(refused(412, 'support.rate_status_refused', 'PRECONDITION_FAILED'));
    expect(await rateRequest(early.api, { ticketId: T1, userId: ME, score: 4, note: '', clientRequestId: 'rate:a' })).toMatchObject({
      message: deskCopy.t('refuseRateNotYet'),
    });
  });

  it('reads the rating that is already there, and only if it is this account’s', async () => {
    const mine = harness(ok(rating()));
    expect(await readRating(mine.api, T1, ME)).toMatchObject({ ok: true, data: { score: 4 } });
    expect(mine.calls[0]!.url).toContain('/api/support/trpc/rating?input=');
    expect(await readRating(harness(ok(null)).api, T1, ME)).toEqual({ ok: true, data: null });
    expect(await readRating(harness(ok(rating({ userId: OTHER }))).api, T1, ME)).toMatchObject({ ok: false });
  });
});

describe('attach', () => {
  const file = { ticketId: T1, userId: ME, contentType: 'image/png', bodyBase64: 'aGkh', byteLength: 3, clientRequestId: 'attach:a' };
  const stored = (over: Record<string, unknown> = {}) => ({
    id: '44444444-4444-4444-8444-444444444444',
    ticketId: T1,
    ownerId: ME,
    contentType: 'image/png',
    byteLength: 3,
    scanState: 'clean',
    createdAt: '2026-10-17T02:00:00.000Z',
    ...over,
  });

  it('sends the type, the body and the request id, and checks the stored size', async () => {
    const { api, calls } = harness(ok(stored()));
    expect((await attachFile(api, file)).ok).toBe(true);
    expect(calls[0]).toEqual({
      url: '/api/support/trpc/attach',
      method: 'POST',
      body: { ticketId: T1, clientRequestId: 'attach:a', contentType: 'image/png', bodyBase64: 'aGkh' },
    });
    expect(await attachFile(harness(ok(stored({ byteLength: 9 }))).api, file)).toMatchObject({ ok: false });
  });

  it('says attachments are off while the service has no store, without naming its settings', async () => {
    const { api } = harness(refused(412, 'support.attachments_unconfigured support.attachment_store', 'PRECONDITION_FAILED'));
    const result = await attachFile(api, file);
    expect(result).toMatchObject({ ok: false, message: deskCopy.t('refuseAttachOff') });
  });
});

describe('help article feedback and related articles', () => {
  it('sends the vote with its request id and checks it is this account’s vote on this article', async () => {
    const vote = { articleId: 'kb-account-access', version: 2, userId: ME, helpful: true };
    const { api, calls } = harness(ok(vote));
    const input = { articleId: 'kb-account-access', userId: ME, helpful: true, clientRequestId: 'kb-feedback:a' };
    expect(await sendArticleFeedback(api, input)).toMatchObject({ ok: true, data: vote });
    expect(calls[0]).toEqual({
      url: '/api/support/trpc/kbFeedback',
      method: 'POST',
      body: { id: 'kb-account-access', helpful: true, clientRequestId: 'kb-feedback:a' },
    });
    expect(await sendArticleFeedback(harness(ok({ ...vote, userId: OTHER })).api, input)).toMatchObject({ ok: false });
    expect(await sendArticleFeedback(harness(ok({ ...vote, articleId: 'other' })).api, input)).toMatchObject({ ok: false });
  });

  it('hands back the first answer when it differs, so the page can say the first answer stands', async () => {
    const first = { articleId: 'kb-a', version: 1, userId: ME, helpful: false };
    const result = await sendArticleFeedback(harness(ok(first)).api, {
      articleId: 'kb-a',
      userId: ME,
      helpful: true,
      clientRequestId: 'kb-feedback:b',
    });
    expect(result).toMatchObject({ ok: true, data: { helpful: false } });
  });

  it('says an article that is no longer published takes no feedback', async () => {
    const { api } = harness(refused(412, 'support.kb.not_published', 'PRECONDITION_FAILED'));
    expect(await sendArticleFeedback(api, { articleId: 'kb-a', userId: ME, helpful: true, clientRequestId: 'x' })).toMatchObject({
      message: deskCopy.t('refuseArticleGone'),
    });
  });

  it('reads related articles for one article id', async () => {
    const { api, calls } = harness(ok([{ id: 'kb-b', titleKey: 't', bodyKey: 'b', version: 1 }]));
    expect(await readRelated(api, 'kb-a')).toMatchObject({ ok: true, data: [{ id: 'kb-b' }] });
    expect(calls[0]!.url).toBe(`/api/support/trpc/kbRelated?input=${encodeURIComponent('{"id":"kb-a"}')}`);
  });
});

describe('attachment limits, files and download', () => {
  const FILE = '44444444-4444-4444-8444-444444444444';
  const row = (over: Record<string, unknown> = {}) => ({
    id: FILE,
    ticketId: T1,
    ownerId: ME,
    contentType: 'image/png',
    byteLength: 3,
    scanState: 'scanning',
    createdAt: '2026-10-17T02:00:00.000Z',
    ...over,
  });
  const blank = { maxBytes: null, allowedTypes: null, maxCount: null, missing: 'support.attachment_store', revision: 0, updatedAt: null };

  it('reads blank limits as null and refuses a shape with extra or missing keys', async () => {
    expect(await readAttachLimits(harness(ok(blank)).api)).toMatchObject({ ok: true, data: { maxBytes: null, allowedTypes: null } });
    expect(await readAttachLimits(harness(ok({ ...blank, extra: 1 })).api)).toMatchObject({ ok: false });
    expect(await readAttachLimits(harness(ok({ maxBytes: 5 })).api)).toMatchObject({ ok: false });
  });

  it('asks for a page size, and believes only files of this request and this person', async () => {
    const { api, calls } = harness(ok([row(), row({ id: '55555555-5555-4555-8555-555555555555', scanState: 'clean' })]));
    const got = await readTicketFiles(api, T1, ME, 100);
    expect(got).toMatchObject({ ok: true });
    expect(calls[0]!.url).toContain('/api/support/trpc/ticketAttachments');
    expect(decodeURIComponent(calls[0]!.url)).toContain('"limit":100');
    expect(await readTicketFiles(harness(ok([row({ ticketId: T2 })])).api, T1, ME, 100)).toMatchObject({ ok: false });
    expect(await readTicketFiles(harness(ok([row({ ownerId: OTHER })])).api, T1, ME, 100)).toMatchObject({ ok: false });
    expect(await readTicketFiles(harness(ok([row({ storeKey: 'k' })])).api, T1, ME, 100)).toMatchObject({ ok: false });
  });

  it('downloads by id and refuses a file that is held in plain words', async () => {
    const body = { id: FILE, contentType: 'application/octet-stream', disposition: 'attachment', byteLength: 3, bodyBase64: 'aGkh' };
    const { api, calls } = harness(ok(body));
    expect(await downloadFile(api, FILE)).toMatchObject({ ok: true, data: { bodyBase64: 'aGkh' } });
    expect(decodeURIComponent(calls[0]!.url)).toContain(FILE);
    expect(await downloadFile(harness(ok({ ...body, contentType: 'text/html' })).api, FILE)).toMatchObject({ ok: false });
    const refused = await downloadFile(
      harness(() =>
        Response.json({ error: { message: 'support.attachment_scan_unknown', data: { code: 'PRECONDITION_FAILED' } } }, { status: 412 }),
      ).api,
      FILE,
    );
    expect(refused).toMatchObject({ ok: false, message: deskCopy.t('refuseAttachHeld') });
  });
});
