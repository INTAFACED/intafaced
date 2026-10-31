import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { asDesk, helpCentre, publishText, saveCategory, saveSection, setAudience, setHelpCentre } from './help-centre.mjs';
import { EDGE, ORIGIN, journeyState } from './stack.mjs';

// J-support-public-16, in the running app (docs/roadmap/journeys.json): two support operators write, review and publish a
// help article in the founder console's article editor, and readers find it once under its section. Founder A is the
// author (the stack's support lead), founder B the second operator. Tests titled "J-support-public-16 #<n>" prove a step.
const J = 'J-support-public-16';
const SCRIPT = '<script>window.__j16 = 1</script>';
// Not serial: a step that is not built yet fails alone. Step 1 starts the run in the journey's state file, so a later
// step on a new worker (Playwright starts one after a failure) works on the same article.
const state = journeyState(J);

/** The article, its category, section and template for one run. */
function names(run) {
  const category = { id: `j16-${run}`, name: `TEST ${J} ${run} money`, position: 9100, reason: `TEST ${J}` };
  return {
    run,
    ARTICLE: `j16-${run}`,
    TITLE: `TEST How long a withdrawal takes ${run}`,
    category,
    section: { id: `j16-${run}-wd`, categoryId: category.id, name: `TEST withdrawals ${run}`, position: 0, reason: category.reason },
    template: { id: `j16-${run}-how`, name: `TEST How-to ${run}`, body: 'TEST What you need.\n\nTEST The steps.', reason: `TEST ${J}` },
  };
}

/** The run step 1 started, once it saved its draft. */
function current() {
  const { run, draft } = state.read();
  if (!run || !draft) throw new Error('step 1 saved no draft, so this step cannot start');
  return names(run);
}

/** The category, the section and the template the run writes into. */
async function library(n) {
  await saveCategory(n.category);
  await saveSection(n.section);
  const templates = await desk('lead', 'query', 'kbTemplates');
  if (!templates.some((t) => t.id === n.template.id))
    await desk('lead', 'mutation', 'kbSaveTemplate', { ...n.template, expectedRevision: 0 });
}

/** A desk call that must succeed, as the lead (founder A) or the agent (founder B). */
async function desk(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
}
const history = (id) => desk('lead', 'query', 'kbHistory', { id });

/** The founder console's article editor, signed in as founder `key`, with the article's id filled in. */
async function editor(browser, key, id) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/support/articles`);
  const panel = page.getByTestId('kb-editor');
  await expect(panel.getByRole('heading', { name: 'Write a help article' })).toBeVisible();
  await panel.getByLabel('Article id (letters, numbers and dashes)').fill(id);
  await panel.getByLabel('Article id (letters, numbers and dashes)').blur();
  return { page, panel };
}

async function confirm(panel, button, label) {
  await panel.getByRole('button', { name: button, exact: true }).click();
  await panel.getByRole('button', { name: label }).click();
}

test(`${J} #1 a draft with a category, a section, labels and a template is saved as revision one and is not public`, async ({
  browser,
}) => {
  const { run } = state.reset({ run: Date.now().toString(36) });
  const { ARTICLE, TITLE, category, section, template } = names(run);
  await library(names(run));
  const { page, panel } = await editor(browser, 'a', ARTICLE);
  await panel.getByLabel('Section').selectOption({ label: `${category.name} › ${section.name}` });
  await panel.getByLabel('Template').selectOption({ label: template.name });
  // The template fills the empty body; the author then writes the answer.
  await expect(panel.getByLabel('Body (blank lines split paragraphs)')).toHaveValue(template.body);
  await panel.getByLabel('Title').fill(TITLE);
  await panel.getByLabel('Body (blank lines split paragraphs)').fill(`TEST A withdrawal is sent once it is approved.\n\nTEST ${run}`);
  await panel.getByLabel('Labels (separated by commas)').fill('withdrawal, timing');
  await confirm(panel, 'Review draft', 'Yes, save the draft');
  await expect(panel.getByTestId('kbe-outcome')).toContainText('Draft saved as revision 1. No reader sees it.');
  const draft = await desk('lead', 'query', 'kbDraft', { id: ARTICLE, revision: 1 });
  expect(draft).toMatchObject({
    revision: 1,
    state: 'draft',
    sectionId: section.id,
    templateId: template.id,
    tags: ['withdrawal', 'timing'],
  });
  // Not public: a reader's read of the article answers nothing.
  const read = await fetch(`${EDGE}/api/support/trpc/getKb?input=${encodeURIComponent(JSON.stringify({ id: ARTICLE }))}`);
  expect(JSON.stringify(await read.json())).not.toContain(TITLE);
  state.write({ draft: draft.revision });
  await page.context().close();
});

test(`${J} #2 the audience is saved, and changing it adds one audit row with the old and the new value`, async () => {
  const n = names(state.read().run ?? Date.now().toString(36));
  const { ARTICLE, run, section } = n;
  await library(n);
  // On an article of its own, so the main article keeps its two versions for step 6.
  const article = await publishText({
    id: `${ARTICLE}-aud`,
    title: `TEST Audience ${run}`,
    body: 'TEST Who may read this.',
    language: 'en',
    sectionId: section.id,
    baseRevision: 0,
  });
  const narrowed = await setAudience(article.id, article.revision, 'signed_in');
  expect(narrowed.audience).toBe('signed_in');
  const changes = await desk('lead', 'query', 'kbAudienceChanges', { id: article.id });
  expect(changes).toEqual([expect.objectContaining({ fromAudience: 'public', toAudience: 'signed_in' })]);
});

test(`${J} #3 a save from a stale revision is refused, and a script tag pasted into the body previews as text`, async ({ browser }) => {
  const { ARTICLE, TITLE, section } = current();
  const stale = await asDesk('lead', 'mutation', 'kbSaveDraft', {
    id: ARTICLE,
    title: TITLE,
    body: 'TEST Stale words.',
    language: 'en',
    sectionId: section.id,
    baseRevision: 0,
  });
  expect(stale.text).toContain('support.kb.revision_stale');
  const { page, panel } = await editor(browser, 'a', ARTICLE);
  await panel.getByLabel('Body (blank lines split paragraphs)').fill(`TEST Paste ${SCRIPT} here.`);
  await expect(panel.getByTestId('kbe-preview')).toContainText(`TEST Paste ${SCRIPT} here.`);
  expect(await page.evaluate(() => window.__j16)).toBeUndefined();
  // Nothing was saved by either: the draft is still the only version.
  expect((await history(ARTICLE)).versions.map((v) => v.revision)).toEqual([1]);
  await page.context().close();
});

test(`${J} #4 the draft goes to review, and its author approving it is refused with support.kb_same_operator`, async ({ browser }) => {
  const { ARTICLE } = current();
  const { page, panel } = await editor(browser, 'a', ARTICLE);
  await confirm(panel, 'Send for review', 'Yes, send for review');
  await expect(panel.getByTestId('kbe-outcome')).toContainText('Revision 1 is in review.');
  await expect(panel.getByTestId('kbe-draft')).toContainText('In review');
  await confirm(panel, 'Approve', 'Yes, approve');
  await expect(panel.getByTestId('kbe-outcome')).toContainText('support.kb_same_operator');
  await expect(panel.getByTestId('kbe-draft')).toContainText('In review');
  await page.context().close();
});

test(`${J} #5 a second operator approves, publish is allowed once with submit, approve and publish rows; an approved article edited returns to draft`, async ({
  browser,
}) => {
  const { ARTICLE, run, section } = current();
  const second = await editor(browser, 'b', ARTICLE);
  await confirm(second.panel, 'Approve', 'Yes, approve');
  await expect(second.panel.getByTestId('kbe-outcome')).toContainText('Revision 1 is approved.');
  await second.page.context().close();
  // The approval replayed changes nothing.
  await desk('agent', 'mutation', 'kbApprove', { id: ARTICLE, revision: 1 });
  const { page, panel } = await editor(browser, 'a', ARTICLE);
  await confirm(panel, 'Publish', 'Yes, publish');
  await expect(panel.getByTestId('kbe-outcome')).toContainText('Published as version 2.');
  // Once: a second publish answers the same version.
  expect(await desk('lead', 'mutation', 'kbPublishDraft', { id: ARTICLE, revision: 1 })).toMatchObject({ version: 2 });
  expect((await history(ARTICLE)).trail.map((r) => r.action)).toEqual(['submit', 'approve', 'publish']);
  await page.context().close();

  // An approved draft edited again is a new draft with no approval; the old approval cannot publish.
  const other = `${ARTICLE}-edit`;
  const body = { title: `TEST Edited ${run}`, language: 'en', sectionId: section.id };
  await desk('lead', 'mutation', 'kbSaveDraft', { id: other, ...body, body: 'TEST First words.', baseRevision: 0 });
  await desk('lead', 'mutation', 'kbSubmitForReview', { id: other, revision: 1 });
  await desk('agent', 'mutation', 'kbApprove', { id: other, revision: 1 });
  expect(await desk('lead', 'mutation', 'kbSaveDraft', { id: other, ...body, body: 'TEST Second words.', baseRevision: 1 })).toMatchObject({
    revision: 2,
    state: 'draft',
  });
  expect((await asDesk('lead', 'mutation', 'kbPublishDraft', { id: other, revision: 1 })).text).toContain('support.kb.revision_stale');
});

test(`${J} #6 /help lists the article once under its section, and the version table holds two immutable rows`, async ({ browser }) => {
  const { ARTICLE, TITLE, section } = current();
  const context = await browser.newContext({ baseURL: ORIGIN });
  const page = await context.newPage();
  await page.goto(`/help/section/${section.id}`);
  const rows = page.locator('main').getByTestId('help__row');
  await expect(rows.filter({ hasText: TITLE })).toHaveCount(1, { timeout: 10_000 });
  await context.close();
  const versions = (await history(ARTICLE)).versions;
  expect(versions.map((v) => [v.revision, v.draft, v.live])).toEqual([
    [1, true, false],
    [2, false, true],
  ]);
});

test(`${J} #7 restricting the article to a segment with the segment cap blank is refused with support.kb_segment_cap_unset`, async () => {
  const { ARTICLE, run } = current();
  const res = await asDesk('lead', 'mutation', 'setKbSegment', { id: ARTICLE, segment: `TEST ${run}` });
  expect(res.status, `setKbSegment: ${res.text.slice(0, 200)}`).not.toBe(404);
  expect(res.text).toContain('support.kb_segment_cap_unset');
});

test(`${J} #8 the help centre settings show name, theme and languages, and a missing translation is listed in the desk`, async () => {
  const settings = await helpCentre();
  expect(settings).toHaveProperty('name');
  expect(settings).toHaveProperty('languages');
  expect(settings).toHaveProperty('theme');
  const translations = await desk('lead', 'query', 'helpCentreTranslations', { limit: 100 });
  expect(JSON.stringify(translations)).toContain('missing');
});

test(`${J} #9 the publish switch change is audited with its reason; switched off, /help says so`, async ({ browser }) => {
  const before = await helpCentre();
  const reason = `TEST ${J} #9 off`;
  try {
    await setHelpCentre({ published: false }, reason);
    const context = await browser.newContext({ baseURL: ORIGIN });
    const page = await context.newPage();
    await page.goto('/help');
    await expect(page.locator('main').getByTestId('help-centre-off')).toContainText('The help centre is switched off');
    await context.close();
    const log = await desk('lead', 'query', 'helpCentreChanges', { limit: 20 });
    expect(JSON.stringify(log)).toContain(reason);
  } finally {
    await setHelpCentre({ published: before.published }, `TEST ${J} #9 back`);
  }
});
