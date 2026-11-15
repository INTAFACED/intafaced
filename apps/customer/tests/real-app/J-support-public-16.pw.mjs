// World: book
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { asDesk, helpCentre, publishText, saveCategory, saveSection, setAudience, setHelpCentre, unpublish } from './help-centre.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { EDGE, ORIGIN, ROOT, journeyState } from './stack.mjs';

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

/** svc-support's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
async function supportDb() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const postgres = createRequire(path.join(ROOT, 'services', 'svc-support', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_support:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}

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

test(`${J} #3 a save from a stale revision is refused with support.kb_revision_stale, and a script tag pasted into the body previews as text`, async ({
  browser,
}) => {
  const { ARTICLE, TITLE, run, category, section } = current();
  // In the editor: the author opens an article at revision 1, the second operator saves revision 2 first, and the
  // author's save, from revision 1, is refused by name. On an article of its own, so the main article keeps revision 1.
  const side = `${ARTICLE}-stale`;
  const words = { title: `TEST Stale ${run}`, language: 'en', sectionId: section.id };
  await desk('lead', 'mutation', 'kbSaveDraft', { id: side, ...words, body: 'TEST First words.', baseRevision: 0 });
  const author = await editor(browser, 'a', side);
  await expect(author.panel.getByTestId('kbe-draft')).toContainText('Newest draft: revision 1,');
  await desk('agent', 'mutation', 'kbSaveDraft', { id: side, ...words, body: 'TEST Second operator words.', baseRevision: 1 });
  await author.panel.getByLabel('Section').selectOption({ label: `${category.name} › ${section.name}` });
  await author.panel.getByLabel('Title').fill(words.title);
  await author.panel.getByLabel('Body (blank lines split paragraphs)').fill(`TEST Author words ${run}.`);
  await confirm(author.panel, 'Review draft', 'Yes, save the draft');
  const outcome = author.panel.getByTestId('kbe-outcome');
  await expect(outcome).toContainText('Someone changed this article first');
  await expect(outcome).toContainText('Code: support.kb_revision_stale');
  await author.page.context().close();
  // Nothing was saved by the stale save: revision 2 is the second operator's, and the author's words are nowhere.
  const sideHistory = await history(side);
  expect(sideHistory.versions.map((v) => v.revision)).toEqual([1, 2]);
  expect((await desk('lead', 'query', 'kbDraft', { id: side, revision: 2 })).body).toBe('TEST Second operator words.');
  expect(JSON.stringify(sideHistory)).not.toContain(`TEST Author words ${run}.`);

  // The same refusal from the desk's own door, on the main article: a save from revision 0 after revision 1.
  const stale = await asDesk('lead', 'mutation', 'kbSaveDraft', {
    id: ARTICLE,
    title: TITLE,
    body: 'TEST Stale words.',
    language: 'en',
    sectionId: section.id,
    baseRevision: 0,
  });
  expect(stale.status).toBe(409);
  expect(stale.text).toContain('support.kb_revision_stale');

  // A script tag pasted into the body: the preview shows it as text, adds no script element, and runs nothing.
  const { page, panel } = await editor(browser, 'a', ARTICLE);
  await panel.getByLabel('Body (blank lines split paragraphs)').fill(`TEST Paste ${SCRIPT} here.`);
  const preview = panel.getByTestId('kbe-preview');
  await expect(preview.getByText(`TEST Paste ${SCRIPT} here.`, { exact: true })).toBeVisible();
  await expect(preview.locator('script')).toHaveCount(0);
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
  expect((await asDesk('lead', 'mutation', 'kbPublishDraft', { id: other, revision: 1 })).text).toContain('support.kb_revision_stale');
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
  // The version table itself: two rows, and neither can be changed or removed.
  const sql = await supportDb();
  try {
    const stored = () =>
      sql`SELECT version, title, body, title_key, body_key FROM support.kb_article_versions WHERE id = ${ARTICLE} ORDER BY version`;
    const before = await stored();
    expect(before.map((row) => row.version)).toEqual([1, 2]);
    for (const { version } of before) {
      await expect(
        sql`UPDATE support.kb_article_versions SET body = ${'TEST rewritten'} WHERE id = ${ARTICLE} AND version = ${version}`,
      ).rejects.toThrow(/kb_article_versions is immutable: UPDATE refused|permission denied/);
      await expect(sql`DELETE FROM support.kb_article_versions WHERE id = ${ARTICLE} AND version = ${version}`).rejects.toThrow(
        /kb_article_versions is immutable: DELETE refused|permission denied/,
      );
    }
    expect(await stored()).toEqual(before);
  } finally {
    await sql.end();
  }
});

test(`${J} #7 restricting the article to a segment with the segment cap blank is refused with support.kb_segment_cap_unset`, async () => {
  const { ARTICLE, run } = current();
  const before = await history(ARTICLE);
  const res = await asDesk('lead', 'mutation', 'setKbSegment', { id: ARTICLE, segment: `TEST ${run}` });
  expect(res.status, `setKbSegment: ${res.text.slice(0, 200)}`).not.toBe(200);
  expect(res.status, `setKbSegment: ${res.text.slice(0, 200)}`).not.toBe(404);
  // The refusal is the blank cap's own: the segment cap is not set on this stack.
  expect(res.text).toContain('support.kb_segment_cap_unset');
  // Nothing moved: no segment is on the article, and its versions and trail are as they were.
  const after = await history(ARTICLE);
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toContain(`TEST ${run}`);
});

test(`${J} #8 the help centre settings show name, theme and languages (none set: "languages are not set" and no picker), and a missing translation is listed in the desk`, async ({
  browser,
}) => {
  const n = names(state.read().run ?? Date.now().toString(36));
  await library(n);
  // An answer of its own, so a reader's page has an article whose language picker can be looked for.
  const answer = await publishText({
    id: `${n.ARTICLE}-lang`,
    title: `TEST Languages ${n.run}`,
    body: 'TEST Which language this answer is in.',
    language: 'en',
    sectionId: n.section.id,
    baseRevision: 0,
  });
  const before = await helpCentre();
  const deskPage = await browser.newContext({ viewport: { width: 1440, height: 1000 } }).then((c) => c.newPage());
  await founderSignIn(deskPage, 'a');
  const reader = await browser.newContext({ baseURL: ORIGIN }).then((c) => c.newPage());
  const settingsPanel = async () => {
    await deskPage.goto(`${ADMIN}/support/settings`);
    const panel = deskPage.getByTestId('help-centre-panel');
    await expect(panel.getByRole('heading', { name: 'Help centre', exact: true })).toBeVisible();
    return panel;
  };
  const readerPicker = async () => {
    await reader.goto(`/helpdetail?id=${answer.id}`);
    const main = reader.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: answer.title })).toBeVisible();
    return main.getByRole('combobox', { name: 'Article language' });
  };
  const theme = { system: 'Follows the reader’s device', light: 'Light', dark: 'Dark' };
  try {
    // None set: the desk says "Languages are not set" and counts no gap; there is no picker, in the desk or for a reader.
    if (before.languages !== null) await setHelpCentre({ languages: null }, `TEST ${J} #8 offer no language`);
    const blank = await helpCentre();
    expect(blank.languages).toBeNull();
    let panel = await settingsPanel();
    // Name and theme are the service's own values, "Not set" while the owner has chosen none.
    await expect(panel.getByTestId('help-centre-name')).toHaveText(blank.name ?? 'Not set');
    await expect(panel.getByTestId('help-centre-theme')).toHaveText(blank.theme ? theme[blank.theme] : 'Not set');
    await expect(panel.getByTestId('help-centre-languages')).toContainText('Languages are not set');
    await expect(panel.getByTestId('help-centre-missing-none')).toHaveText('Languages are not set, so no translation gap is counted.');
    await expect(panel.getByRole('combobox')).toHaveCount(0);
    await expect(await readerPicker()).toHaveCount(0);

    // One language offered: the reader gets a picker, and the desk lists the answer versions not yet translated into it.
    const language = before.languages?.[0] ?? before.defaultLanguage ?? 'en';
    await setHelpCentre({ languages: [language] }, `TEST ${J} #8 offer a language`);
    await expect(await readerPicker()).toHaveCount(1);
    const translations = await desk('lead', 'query', 'helpCentreTranslations', { limit: 100 });
    expect(translations.languages).toEqual([language]);
    const missing = translations.rows.filter((row) => row.state === 'missing');
    expect(missing.length).toBeGreaterThan(0);
    panel = await settingsPanel();
    await expect(panel.getByTestId('help-centre-languages')).toContainText(language);
    await expect(panel.getByTestId('help-centre-missing-count')).toHaveText(
      `${missing.length} missing in the first ${translations.rows.length} of ${translations.total} article versions × languages.`,
    );
    await expect(panel.getByTestId('help-centre-missing-row')).toHaveText(
      missing.map((row) => `${row.articleId} version ${row.version} · ${row.language} · missing`),
    );
  } finally {
    await setHelpCentre({ languages: before.languages }, `TEST ${J} #8 put the languages back`);
    await deskPage.context().close();
    await reader.context().close();
    await unpublish(answer.id, answer.revision);
  }
});

test(`${J} #9 the publish switch change is audited with its reason; switched off, /help says so`, async ({ browser }) => {
  const before = await helpCentre();
  const reasonOff = `TEST ${J} #9 off`;
  const reasonOn = `TEST ${J} #9 on`;
  const changes = () => desk('lead', 'query', 'helpCentreChanges', { limit: 50 });
  /** The newest change row with this reason, which must name the publish switch and its old and new value. */
  const audited = async (reason, from, to) => {
    const row = (await changes()).find((change) => change.reason === reason);
    expect(row, `no change row with reason ${reason}`).toBeDefined();
    expect(row.changed).toContain('published');
    expect(row.before.published).toBe(from);
    expect(row.after.published).toBe(to);
    return row;
  };
  try {
    // The switch starts off so turning it on is a change of its own.
    if (before.published !== false) await setHelpCentre({ published: false }, `TEST ${J} #9 start off`);
    // Turning it on is audited with its reason.
    await setHelpCentre({ published: true }, reasonOn);
    await audited(reasonOn, false, true);
    expect((await helpCentre()).published).toBe(true);
    // Turned off, audited too, and /help states it is switched off.
    await setHelpCentre({ published: false }, reasonOff);
    await audited(reasonOff, true, false);
    const context = await browser.newContext({ baseURL: ORIGIN });
    const page = await context.newPage();
    await page.goto('/help');
    await expect(page.locator('main').getByTestId('help-centre-off')).toContainText('The help centre is switched off');
    await context.close();
  } finally {
    await setHelpCentre({ published: before.published }, `TEST ${J} #9 back`);
  }
});
