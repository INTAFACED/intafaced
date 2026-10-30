import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryHelpCentreBook } from './help-centre.js';
import { MemoryKbLibraryBook } from './kb-library.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemorySupportStore } from './store.js';
import { KbAuthoring } from './kb-authoring.js';
import { MemoryKbReviewBook } from './kb-review.js';

/** SP-kb-01: categories and sections made by staff, articles typed as text, read signed out. J-support-public-01 #3, #5. */

const authConfig = {
  secret: 'a-support-kb-library-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const REVIEWER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';
const reason = 'TEST library';

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-kb-library' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-kb-library' };
}

async function desk() {
  const library = new MemoryKbLibraryBook();
  const helpCentre = new MemoryHelpCentreBook();
  const store = new MemorySupportStore();
  const support = new SupportService(store, undefined, undefined, new MemoryStaffBook());
  const router = createSupportRouter(
    support,
    undefined,
    undefined,
    support,
    undefined,
    undefined,
    undefined,
    undefined,
    helpCentre,
    library,
    undefined,
    undefined,
    new KbAuthoring(store, new MemoryKbReviewBook()),
  );
  const as = async (userId: string | null, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  const staff = await as(LEAD);
  await staff.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
  const reviewer = await as(REVIEWER);
  /** Typed text goes live through review (SP-kb-02): the lead writes and submits, a second operator approves. */
  const publish = async (row: ReturnType<typeof article>) => {
    const { baseRevision, ...text } = row;
    const draft = await staff.kbSaveDraft({ ...text, baseRevision });
    await staff.kbSubmitForReview({ id: draft.id, revision: draft.revision });
    await reviewer.kbApprove({ id: draft.id, revision: draft.revision });
    return staff.kbPublishDraft({ id: draft.id, revision: draft.revision });
  };
  return { library, staff, reviewer, publish, visitor: await as(null), customer: await as(CUSTOMER, ['support:read', 'support:write']) };
}

const article = (over: Record<string, unknown> = {}) => ({
  id: 'withdraw-time',
  title: 'How long a withdrawal takes',
  body: 'A withdrawal is sent once it is approved.\n\nThe network then confirms it.',
  language: 'en',
  sectionId: 'withdrawals',
  baseRevision: 0,
  ...over,
});

describe('help library (SP-kb-01)', () => {
  it('is empty until staff create a category: no seeded category, section or sample article', async () => {
    const { visitor } = await desk();
    expect(await visitor.kbLibrary()).toEqual({ categories: [] });
    await expect(visitor.kbSection({ sectionId: 'withdrawals', limit: 50 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'support.kb_section_unknown',
    });
  });

  it('lists only published articles under their section, with a measured count, and the text reads back as typed', async () => {
    const { staff, visitor, publish } = await desk();
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    await staff.kbSaveSection({ id: 'deposits', categoryId: 'money', name: 'Deposits', position: 0, reason });
    const published = await publish(article({ body: 'Paste <script>alert(1)</script> here.\n\nThen wait.' }));
    expect(published).toMatchObject({
      id: 'withdraw-time',
      // The draft is version 1; the published copy of it is version 2.
      version: 2,
      title: 'How long a withdrawal takes',
      language: 'en',
      sectionId: 'withdrawals',
    });
    expect(published.body).toBe('Paste <script>alert(1)</script> here.\n\nThen wait.');
    const hidden = await publish(article({ id: 'withdraw-hidden', title: 'Hidden' }));
    await staff.unpublishKb({ id: 'withdraw-hidden', baseRevision: hidden.revision! });

    const library = await visitor.kbLibrary();
    expect(library.categories).toHaveLength(1);
    expect(library.categories[0]!.sections.map((s) => [s.id, s.articleCount])).toEqual([
      ['deposits', 0],
      ['withdrawals', 1],
    ]);
    const page = await visitor.kbSection({ sectionId: 'withdrawals', limit: 50 });
    expect(page.category).toEqual({ id: 'money', name: 'Money' });
    expect(page.articles.map((a) => a.id)).toEqual(['withdraw-time']);
    expect((await visitor.kbSection({ sectionId: 'deposits', limit: 50 })).articles).toEqual([]);
    expect(await visitor.getKb({ id: 'withdraw-time' })).toMatchObject({ title: 'How long a withdrawal takes', sectionId: 'withdrawals' });
    // The spine keyed in the catalogue reads as before: no section, no text.
    const spine = await visitor.getKb({ id: 'kb-account-access' });
    expect(spine).not.toHaveProperty('title');
    expect(spine).not.toHaveProperty('sectionId');
  });

  it('a new body is a new version; an unpublish and an audience change keep the text', async () => {
    const { staff, visitor, customer, publish } = await desk();
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    const first = await publish(article());
    const second = await publish(article({ body: 'Second body.', baseRevision: first.revision! }));
    // Draft 1, published 2, draft 3, published 4.
    expect(second.version).toBe(4);
    expect(await visitor.getKb({ id: 'withdraw-time', version: 2 })).toMatchObject({ body: first.body });
    await expect(staff.kbSaveDraft({ ...article({ body: 'Stale.' }), baseRevision: first.revision! })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const narrowed = await staff.setKbAudience({ id: 'withdraw-time', baseRevision: second.revision!, audience: 'signed_in' });
    expect(narrowed).toMatchObject({ body: 'Second body.', sectionId: 'withdrawals', audience: 'signed_in' });
    expect(await visitor.getKb({ id: 'withdraw-time' })).toBeNull();
    expect((await visitor.kbSection({ sectionId: 'withdrawals', limit: 50 })).articles).toEqual([]);
    expect((await customer.kbSection({ sectionId: 'withdrawals', limit: 50 })).articles.map((a) => a.body)).toEqual(['Second body.']);
  });

  it('refuses a blank title, a bad body, an unknown or retired section and an unknown category, and stores nothing', async () => {
    const { staff, visitor, customer } = await desk();
    await expect(staff.kbSaveSection({ id: 's', categoryId: 'nope', name: 'S', position: 0, reason })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'support.kb_category_unknown',
    });
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    await expect(staff.kbPublishText(article({ title: '   ' }))).rejects.toMatchObject({ message: 'support.kb_title_blank' });
    await expect(staff.kbPublishText(article({ body: 'bad \u0007 bell' }))).rejects.toMatchObject({ message: 'support.kb_body_invalid' });
    await expect(staff.kbPublishText(article({ sectionId: 'nowhere' }))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.kb_section_unknown',
    });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, retired: true, reason });
    await expect(staff.kbPublishText(article())).rejects.toMatchObject({ message: 'support.kb_section_unknown' });
    await expect(customer.kbSaveCategory({ id: 'x', name: 'X', position: 0, reason })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await visitor.getKb({ id: 'withdraw-time' })).toBeNull();
    expect((await visitor.kbLibrary()).categories[0]!.sections).toEqual([]);
  });

  it('refuses a vendor name in article text and in category and section names', async () => {
    const { staff, visitor } = await desk();
    await expect(staff.kbSaveCategory({ id: 'x', name: 'Coinbase help', position: 0, reason })).rejects.toMatchObject({
      message: 'support.kb_vendor_name',
    });
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await expect(staff.kbSaveSection({ id: 's', categoryId: 'money', name: 'From Kraken', position: 0, reason })).rejects.toMatchObject({
      message: 'support.kb_vendor_name',
    });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    await expect(staff.kbPublishText(article({ body: 'Works like Binance.' }))).rejects.toMatchObject({
      message: 'support.kb_vendor_name',
    });
    expect(await visitor.getKb({ id: 'withdraw-time' })).toBeNull();
  });

  it('a publish retried after a lost reply gets the version it made; a different text on the same base is stale', async () => {
    const { staff, publish } = await desk();
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    const first = await publish(article());
    const again = await staff.kbPublishDraft({ id: first.id, revision: 1 });
    expect(again).toMatchObject({ id: first.id, version: first.version, revision: first.revision, body: first.body });
    await expect(staff.kbSaveDraft({ ...article({ body: 'Another body.' }), baseRevision: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('typed text no longer goes live without review: the direct publish refuses after its checks', async () => {
    const { staff, visitor } = await desk();
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    await expect(staff.kbPublishText(article())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'support.kb_review_required',
    });
    expect(await visitor.getKb({ id: 'withdraw-time' })).toBeNull();
  });

  it('retiring a category takes it and its sections off the list; saving the same values writes no log row', async () => {
    const { staff, visitor, library } = await desk();
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason: 'again' });
    expect(library.log).toHaveLength(1);
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, retired: true, reason: 'retire' });
    expect(await visitor.kbLibrary()).toEqual({ categories: [] });
    await expect(visitor.kbSection({ sectionId: 'withdrawals', limit: 50 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(library.log).toHaveLength(3);
  });

  it('a section page needs a page size, and the library sits behind the help-centre switch', async () => {
    const { staff, visitor } = await desk();
    await staff.kbSaveCategory({ id: 'money', name: 'Money', position: 1, reason });
    await staff.kbSaveSection({ id: 'withdrawals', categoryId: 'money', name: 'Withdrawals', position: 1, reason });
    await expect(visitor.kbSection({ sectionId: 'withdrawals' })).rejects.toMatchObject({ message: expect.stringContaining('limit') });
    await staff.setHelpCentre({ reason, expectedRevision: 0, published: false });
    await expect(visitor.kbLibrary()).rejects.toMatchObject({ message: 'support.help_centre_off' });
    await expect(visitor.kbSection({ sectionId: 'withdrawals', limit: 5 })).rejects.toMatchObject({ message: 'support.help_centre_off' });
  });
});
