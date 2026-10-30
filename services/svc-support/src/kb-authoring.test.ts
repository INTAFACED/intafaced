import { describe, expect, it } from 'vitest';
import { KbAuthoring } from './kb-authoring.js';
import { MemoryKbReviewBook } from './kb-review.js';
import { MemorySupportStore } from './store.js';

/** SP-kb-01 and SP-kb-02 rules on the in-memory store; the same rules on Postgres are in kb-review.pg.test.ts. */

const AUTHOR = 'author-1';
const REVIEWER = 'reviewer-1';
const text = (over: Record<string, unknown> = {}) => ({
  id: 'withdraw-time',
  title: 'How long a withdrawal takes',
  body: 'A withdrawal is sent once it is approved.',
  language: 'en',
  sectionId: 'withdrawals',
  baseRevision: 0,
  ...over,
});

const make = () => {
  const book = new MemoryKbReviewBook();
  return { book, kb: new KbAuthoring(new MemorySupportStore(), book, () => '2026-10-30T14:00:00.000Z') };
};

describe('help-article authoring and review', () => {
  it('a template must exist and be live; with one, the draft names it', async () => {
    const { kb } = make();
    expect(await kb.listTemplates()).toEqual([]);
    await expect(kb.saveDraft(AUTHOR, text({ templateId: 'how-to' }))).rejects.toMatchObject({ code: 'support.kb_template_unknown' });
    const template = await kb.saveTemplate(AUTHOR, { id: 'how-to', name: 'How-to', body: 'Steps:', expectedRevision: 0, reason: 'TEST' });
    await expect(
      kb.saveTemplate(AUTHOR, { id: 'how-to', name: 'How-to', body: 'Steps:', expectedRevision: 0, reason: 'TEST' }),
    ).rejects.toMatchObject({ code: 'support.kb_template_revision_stale' });
    expect((await kb.saveDraft(AUTHOR, text({ templateId: template.id }))).templateId).toBe('how-to');
    await kb.saveTemplate(AUTHOR, { id: 'how-to', name: 'How-to', body: 'Steps:', retired: true, expectedRevision: 1, reason: 'TEST' });
    await expect(kb.saveDraft(AUTHOR, text({ templateId: 'how-to', baseRevision: 1 }))).rejects.toMatchObject({
      code: 'support.kb_template_unknown',
    });
  });

  it('refuses a blank title, a bad body and a vendor name before anything is stored', async () => {
    const { kb } = make();
    await expect(kb.saveDraft(AUTHOR, text({ title: ' ' }))).rejects.toMatchObject({ code: 'support.kb_title_blank' });
    await expect(kb.saveDraft(AUTHOR, text({ body: 'bad \u0007' }))).rejects.toMatchObject({ code: 'support.kb_body_invalid' });
    await expect(kb.saveDraft(AUTHOR, text({ body: 'Works like Binance.' }))).rejects.toMatchObject({ code: 'support.kb_vendor_name' });
    expect((await kb.history('withdraw-time')).versions).toEqual([]);
  });

  it('a submit repeated is one trail row; a send back needs review, and a sent-back draft can be submitted again', async () => {
    const { kb } = make();
    await kb.saveDraft(AUTHOR, text());
    await expect(kb.approve(REVIEWER, { id: 'withdraw-time', revision: 1 })).rejects.toMatchObject({ code: 'support.kb_not_in_review' });
    await kb.submit(AUTHOR, { id: 'withdraw-time', revision: 1 });
    await kb.submit(AUTHOR, { id: 'withdraw-time', revision: 1 });
    expect((await kb.sendBack(REVIEWER, { id: 'withdraw-time', revision: 1, reason: 'TEST shorter' })).state).toBe('sent_back');
    await expect(kb.approve(REVIEWER, { id: 'withdraw-time', revision: 1 })).rejects.toMatchObject({ code: 'support.kb_not_in_review' });
    expect((await kb.submit(AUTHOR, { id: 'withdraw-time', revision: 1 })).state).toBe('in_review');
    expect((await kb.history('withdraw-time')).trail.map((r) => [r.action, r.reason])).toEqual([
      ['submit', null],
      ['send_back', 'TEST shorter'],
      ['submit', null],
    ]);
  });

  it('an unknown draft is named as such for every move', async () => {
    const { kb } = make();
    const ref = { id: 'nothing', revision: 1 };
    await expect(kb.submit(AUTHOR, ref)).rejects.toMatchObject({ code: 'support.kb_draft_unknown' });
    await expect(kb.approve(REVIEWER, ref)).rejects.toMatchObject({ code: 'support.kb_draft_unknown' });
    await expect(kb.publish(AUTHOR, ref)).rejects.toMatchObject({ code: 'support.kb_draft_unknown' });
    await expect(kb.draft('nothing', 1)).rejects.toMatchObject({ code: 'support.kb_draft_unknown' });
  });
});
