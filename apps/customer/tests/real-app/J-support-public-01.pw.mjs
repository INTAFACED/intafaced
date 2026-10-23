import { test, expect } from '@playwright/test';
import { contactChannels, helpCentre, publishText, saveCategory, saveSection, setHelpCentre, unpublish } from './help-centre.mjs';
import { signUp } from './desk.mjs';
import { EDGE, ORIGIN } from './stack.mjs';

// J-support-public-01, in the running app (docs/roadmap/journeys.json): a signed-out visitor finds an answer in the help
// centre. Tests titled "J-support-public-01 #<n>" prove a whole step. A step that changes an owner setting puts back what
// it found, so the stack is left as the run met it.
const J = 'J-support-public-01';
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

/** A signed-out visitor on a device of its own. */
async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** The contact card says "not set" for each detail the owner has not published, and no mailto link is drawn for a blank address. */
async function expectContactCard(page) {
  const owner = await contactChannels();
  const card = page.locator('aside.contact-card');
  await expect(card).toBeVisible();
  if (owner.email === null && !process.env.VITE_SUPPORT_EMAIL) {
    await expect(card.getByTestId('support-email-unset')).toContainText('Support email is not set.');
    await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  } else {
    await expect(card.locator('a[href^="mailto:"]')).toHaveCount(1);
  }
  if (owner.phone === null) await expect(card.getByTestId('support-phone-unset')).toHaveText('Support phone is not set.');
  else await expect(card.getByTestId('support-phone')).toContainText(owner.phone);
}

test(`${J} #1 /help is one front door: search, categories, the request button and a contact card that says "not set"`, async ({
  browser,
}) => {
  const page = await visitor(browser);
  await page.goto('/help');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible();
  await expect(main.getByLabel('Search answers')).toBeVisible();
  await expect(main.getByRole('navigation', { name: 'Browse by topic' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Send a request' })).toBeVisible();
  await expectContactCard(page);
  // Signed out, the request button asks for a sign-in in place; no mail draft stands in for the form.
  await main.getByRole('button', { name: 'Send a request' }).click();
  await expect(main.getByTestId('request-sign-in')).toBeVisible();
  await page.context().close();
});

test(`${J} #2 with the help centre switched off, /help says so, keeps the contact card and still renders`, async ({ browser }) => {
  const found = await helpCentre();
  const switched = await setHelpCentre({ published: false }, `TEST ${J} #2 switch the help centre off`);
  expect(switched.published).toBe(false);
  try {
    // The service enforces the switch, not only the page: a signed-out read of the answers refuses by name.
    const res = await fetch(`${EDGE}/api/support/trpc/listKb?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
    expect(res.status).toBe(412);
    expect((await res.json()).error.message).toBe('support.help_centre_off');
    const page = await visitor(browser);
    for (const path of ['/help', '/helpdetail?id=kb-account-access']) {
      await page.goto(path);
      const main = page.locator('main');
      await expect(main.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible();
      await expect(main.getByTestId('help-centre-off')).toContainText('The help centre is switched off');
      await expect(main.getByLabel('Search answers')).toHaveCount(0);
      await expect(main.locator('.help__row, .help__body')).toHaveCount(0);
      await expectContactCard(page);
    }
    await page.context().close();
  } finally {
    const back = await setHelpCentre({ published: found.published }, `TEST ${J} #2 put the switch back`);
    expect(back.published).toBe(found.published);
  }
  // Back as it was: the answers show again.
  const page = await visitor(browser);
  await page.goto('/help');
  await expect(page.locator('main .help__row').first()).toBeVisible();
  await page.context().close();
});

test(`${J} #3 browses a category and then a section: only that section's published answers, and an honest empty section`, async ({
  browser,
}) => {
  // The run's own topic, made by the support lead: one category, a section with two answers (one then taken down) and an
  // empty section. Retired at the end, so the help centre is left as the run found it.
  const category = { id: `j01-${RUN}`, name: `TEST ${J} ${RUN} money`, position: 9000, reason: `TEST ${J} #3` };
  const filled = { id: `j01-${RUN}-wd`, categoryId: category.id, name: `TEST withdrawals ${RUN}`, position: 0, reason: category.reason };
  const empty = { id: `j01-${RUN}-dep`, categoryId: category.id, name: `TEST deposits ${RUN}`, position: 1, reason: category.reason };
  await saveCategory(category);
  try {
    await saveSection(filled);
    await saveSection(empty);
    const shown = await publishText({
      id: `j01-${RUN}-time`,
      title: `TEST How long a withdrawal takes ${RUN}`,
      body: 'TEST A withdrawal is sent once it is approved.\n\nPaste <script>window.__j01 = 1</script> nowhere: this line is text.',
      language: 'en',
      sectionId: filled.id,
      baseRevision: 0,
    });
    const hidden = await publishText({
      id: `j01-${RUN}-old`,
      title: `TEST An answer taken down ${RUN}`,
      body: 'TEST This answer is unpublished before the visitor arrives.',
      language: 'en',
      sectionId: filled.id,
      baseRevision: 0,
    });
    await unpublish(hidden.id, hidden.revision);

    const page = await visitor(browser);
    await page.goto('/help');
    const topics = page.getByRole('navigation', { name: 'Browse by topic' });
    await topics.getByRole('link', { name: category.name }).click();
    await expect(page).toHaveURL(new RegExp(`/help/category/${category.id}$`));
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: category.name })).toBeVisible();
    const rows = main.locator('.help__row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: filled.name })).toContainText('Published answers: 1');
    await expect(rows.filter({ hasText: empty.name })).toContainText('Published answers: 0');

    await rows
      .filter({ hasText: filled.name })
      .getByRole('link', { name: /Open section/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/help/section/${filled.id}$`));
    await expect(main.getByRole('heading', { level: 1, name: filled.name })).toBeVisible();
    await expect(main.getByRole('link', { name: category.name })).toBeVisible();
    await expect(main.locator('.help__row')).toHaveCount(1);
    await expect(main.locator('.help__row h2')).toHaveText(shown.title);
    await expect(main.getByText('An answer taken down')).toHaveCount(0);

    // The answer reads as text: the tag in the body is characters on the page and never runs.
    await main.getByRole('link', { name: `Read answer: ${shown.title}` }).click();
    await expect(main.getByRole('heading', { level: 1, name: shown.title })).toBeVisible();
    await expect(main.locator('.help__body')).toContainText('<script>window.__j01 = 1</script>');
    expect(await page.evaluate(() => window.__j01)).toBeUndefined();

    await page.goto(`/help/section/${empty.id}`);
    await expect(main.getByRole('heading', { level: 1, name: empty.name })).toBeVisible();
    await expect(main.getByText('No answers in this section')).toBeVisible();
    await expect(main.locator('.help__row')).toHaveCount(0);
    await page.context().close();
  } finally {
    await saveCategory({ ...category, retired: true, reason: `TEST ${J} #3 retire the run's topic` });
  }
  const page = await visitor(browser);
  await page.goto(`/help/category/${category.id}`);
  await expect(page.locator('main').getByTestId('help-topic-missing')).toBeVisible();
  await page.context().close();
});

test(`${J} #4 a search lists the labelled answer first, and the typed words survive going to sign in`, async ({ browser }) => {
  // Two answers of the run's own: one labelled with the run's word, one that only mentions it in its body. Both are taken
  // down and the topic retired at the end.
  const word = `j01${RUN}`;
  const category = { id: `j01-${RUN}-s`, name: `TEST ${J} ${RUN} search`, position: 9001, reason: `TEST ${J} #4` };
  const section = { id: `j01-${RUN}-s1`, categoryId: category.id, name: `TEST search ${RUN}`, position: 0, reason: category.reason };
  const made = [];
  await saveCategory(category);
  try {
    await saveSection(section);
    const mentions = await publishText({
      id: `j01-${RUN}-mention`,
      title: `TEST Signing in on a new phone ${RUN}`,
      body: `TEST You can also add the ${word} step from your security page.`,
      language: 'en',
      sectionId: section.id,
      baseRevision: 0,
    });
    made.push(mentions);
    const labelled = await publishText({
      id: `j01-${RUN}-labelled`,
      title: `TEST Use a security key ${RUN}`,
      body: 'TEST A hardware key works as the second step.',
      language: 'en',
      sectionId: section.id,
      baseRevision: 0,
      tags: [word],
    });
    made.push(labelled);

    // A person with an account, signed out on this device.
    const page = await visitor(browser);
    const who = await signUp(page, 'j01s');
    await page.context().clearCookies();

    await page.goto('/help');
    const main = page.locator('main');
    await main.getByRole('textbox', { name: 'Search answers' }).fill(word);
    await main.getByRole('button', { name: 'Search', exact: true }).click();
    const titles = main.locator('.help__row h2');
    await expect(titles).toHaveText([labelled.title, mentions.title]);

    // Signed out, the request button asks for a sign-in in place; that sign-in brings the words to the support desk.
    await main.getByRole('button', { name: 'Send a request' }).click();
    const prompt = main.getByTestId('request-sign-in');
    await expect(prompt.getByRole('link')).toHaveAttribute('href', `/login?redirect=${encodeURIComponent(`/support?q=${word}`)}`);
    await prompt.getByRole('link').click();
    await page.fill('input[name=identifier]', who.email);
    await page.fill('input[name=password]', who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    // The desk opens on its help search with the words already run, then takes them out of the address.
    await expect(page).toHaveURL(/\/support$/);
    await expect(page.getByRole('textbox', { name: 'Search help' })).toHaveValue(word);
    await expect(page.getByText(labelled.title)).toBeVisible();
    await page.context().close();
  } finally {
    for (const row of made) await unpublish(row.id, row.revision);
    await saveCategory({ ...category, retired: true, reason: `TEST ${J} #4 retire the run's topic` });
  }
});

test(`${J} #5 an answer reads as text; another language shows it with a label naming its language; no languages, no picker`, async ({
  browser,
}) => {
  const category = { id: `j01-${RUN}-l`, name: `TEST ${J} ${RUN} language`, position: 9002, reason: `TEST ${J} #5` };
  const section = { id: `j01-${RUN}-l1`, categoryId: category.id, name: `TEST language ${RUN}`, position: 0, reason: category.reason };
  const found = await helpCentre();
  let answer = null;
  await saveCategory(category);
  try {
    await saveSection(section);
    answer = await publishText({
      id: `j01-${RUN}-lang`,
      title: `TEST Where to find your statement ${RUN}`,
      body: 'TEST Statements are under Account.\n\nThis <script>window.__j01lang = 1</script> is text.',
      language: 'en',
      sectionId: section.id,
      baseRevision: 0,
    });
    await setHelpCentre({ languages: ['en', 'es'] }, `TEST ${J} #5 offer two languages`);

    const page = await visitor(browser);
    await page.goto(`/helpdetail?id=${answer.id}`);
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: answer.title })).toBeVisible();
    const picker = main.getByRole('combobox', { name: 'Article language' });
    await expect(picker).toHaveValue('en');
    await expect(main.getByTestId('help-language-fallback')).toHaveCount(0);
    await picker.selectOption('es');
    await expect(main.getByTestId('help-language-fallback')).toHaveText(
      'This answer is not translated into Spanish. It is shown in English.',
    );
    await expect(main.locator('.help__body')).toContainText('This <script>window.__j01lang = 1</script> is text.');
    expect(await page.evaluate(() => window.__j01lang)).toBeUndefined();

    // With no language offered, there is no picker and the answer reads as before.
    await setHelpCentre({ languages: null }, `TEST ${J} #5 offer no language`);
    await page.reload();
    await expect(main.getByRole('heading', { level: 1, name: answer.title })).toBeVisible();
    await expect(main.getByRole('combobox', { name: 'Article language' })).toHaveCount(0);
    await page.context().close();
  } finally {
    await setHelpCentre({ languages: found.languages }, `TEST ${J} #5 put the languages back`);
    if (answer) await unpublish(answer.id, answer.revision);
    await saveCategory({ ...category, retired: true, reason: `TEST ${J} #5 retire the run's topic` });
  }
});
