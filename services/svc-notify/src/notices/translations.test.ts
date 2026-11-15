/**
 * A changelog notice in the reader's chosen language (J-cex-spot-15 #2): the operator's own text per language, read
 * back in that language and named; a language it lacks reads the source text labelled `en`; the approval binds the
 * translations; and nothing but an offered language other than the source is accepted.
 */
import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, NoticeError, type NoticeApprovalConsumer } from './board.js';
import { inLanguage, translationsFromStored } from './translations.js';
// @ts-expect-error a plain .mjs script with no types: the test stack's copy of the payload hash
import { noticePayloadHash } from '../../../../tooling/scripts/local-test-notice.mjs';

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

const board = () =>
  new NoticeBoard(new MemoryNoticeStore(), new Approvals(), new MemoryCommandLog(), () => new Date('2026-10-17T12:00:00.000Z'));

const ES = { title: 'TEST: nuevo campo en las órdenes', body: 'TEST: envía el campo nuevo.' };
const entry = (key: string, translations?: Record<string, { title: string; body: string }>) => ({
  kind: 'changelog',
  title: 'TEST: a new order field',
  body: 'TEST: send the new field.',
  changelog: { area: 'trading', breaking: false },
  ...(translations ? { translations } : {}),
  clientRequestId: key,
});

async function published(b: NoticeBoard, input: Parameters<NoticeBoard['draft']>[1], n = 1) {
  const draft = await b.draft(AUTHOR, input);
  return b.publish(AUTHOR, { id: draft.id, clientRequestId: `pub-${n}`, approvalId: `appr-${n}`, operationId: `op-${n}` });
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err instanceof NoticeError ? err.code : 'other';
  }
  return 'accepted';
};

describe('changelog notices in the chosen language', () => {
  it('reads the operator’s Spanish in Spanish, and the English source, labelled, in a language it lacks', async () => {
    const b = board();
    await published(b, entry('t1', { es: ES }));
    const [es] = await b.changelog({ limit: 10, language: 'es' });
    expect(es).toMatchObject({ title: ES.title, body: ES.body, language: 'es' });
    const [de] = await b.changelog({ limit: 10, language: 'de' });
    expect(de).toMatchObject({ title: 'TEST: a new order field', body: 'TEST: send the new field.', language: 'en' });
    const [none] = await b.changelog({ limit: 10 });
    expect(none?.language).toBe('en');
  });

  it('the upcoming list reads in the chosen language too', async () => {
    const b = board();
    await published(b, {
      ...entry('t2', { es: ES }),
      changelog: { area: 'trading', breaking: true, releaseOn: '2026-12-01', migrationNote: 'TEST: send the new field.' },
    });
    const read = await b.upcomingChanges(new Date('2026-10-17T12:00:00.000Z'), 'es');
    expect(read.upcoming[0]).toMatchObject({ title: ES.title, language: 'es' });
  });

  it('refuses the source language, a language the app does not offer, and blank text', async () => {
    const b = board();
    expect(await code(b.draft(AUTHOR, entry('r1', { en: ES })))).toBe('notify.notice_translation_invalid');
    expect(await code(b.draft(AUTHOR, entry('r2', { xx: ES })))).toBe('notify.notice_translation_invalid');
    expect(await code(b.draft(AUTHOR, entry('r3', { es: { title: '  ', body: 'x' } })))).toBe('notify.notice_translation_invalid');
  });

  it('the publish approval binds the translations: a different Spanish text is a different payload', async () => {
    const b = board();
    const plain = await b.draft(AUTHOR, entry('h1'));
    const withEs = await b.draft(AUTHOR, entry('h2', { es: ES }));
    const otherEs = await b.draft(AUTHOR, entry('h3', { es: { ...ES, body: 'TEST: otro texto.' } }));
    const hashes = await Promise.all([plain, withEs, otherEs].map(async (row) => (await b.publishProposal(row.id)).payloadHash));
    expect(new Set(hashes).size).toBe(3);
  });

  it('stored translations are checked on the way out, and a missing language falls back to the source', () => {
    expect(() => translationsFromStored({ es: { title: 1 } })).toThrow(NoticeError);
    expect(translationsFromStored(null)).toEqual({});
    expect(inLanguage({ title: 'a', body: 'b' }, { es: ES }, 'fr')).toEqual({ title: 'a', body: 'b', language: 'en' });
  });

  it('the test stack hashes a translated changelog draft exactly as the board does, so its four-eyes publish lands', async () => {
    const b = board();
    const translations = { fr: { title: 'TEST : un nouveau champ', body: 'TEST : envoyez le champ.' }, es: ES };
    const draft = await b.draft(AUTHOR, {
      ...entry('m1', translations),
      changelog: { area: 'trading', breaking: false, endpoints: ['/api/v1/orders'] },
    });
    const { payloadHash } = await b.publishProposal(draft.id);
    expect(
      noticePayloadHash({ ...draft, translations, statusFields: { impact: null, components: [], parentId: null, resolves: false } }),
    ).toBe(payloadHash);
  });
});
