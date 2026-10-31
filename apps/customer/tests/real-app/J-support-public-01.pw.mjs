import { test, expect } from '@playwright/test';
import {
  contactChannels,
  feedbackSummary,
  helpCentre,
  publishText,
  saveCategory,
  saveSection,
  setAudience,
  setContact,
  setHelpCentre,
  unpublish,
} from './help-centre.mjs';
import { signUp } from './desk.mjs';
import { EDGE, ORIGIN, api, signOutBrowser } from './stack.mjs';

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

/** The page's text once no answer or contact read is loading and three reads 500 ms apart agree. */
async function settled(main) {
  const reads = [];
  await expect
    .poll(
      async () => {
        const text = await main.innerText();
        reads.push(text);
        const last = reads.slice(-3);
        return last.length === 3 && last.every((t) => t === text) && !/Loading (this answer|contact details)/.test(text);
      },
      { intervals: [500] },
    )
    .toBe(true);
  return reads.at(-1);
}

/** The contact card says "not set" for each detail the owner has not published, and no mailto link is drawn for a blank address. */
async function expectContactCard(page) {
  const owner = await contactChannels();
  const card = page.locator('aside[data-testid="contact-card"]');
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
  // The owner's contact details are cleared for this step, so "not set" is what the card must say, then put back.
  if (process.env.VITE_SUPPORT_EMAIL) throw new Error('this build carries VITE_SUPPORT_EMAIL, so the "not set" state cannot be shown');
  const found = await contactChannels();
  const hadDetails = found.email !== null || found.phone !== null || found.chatHours !== null;
  if (hadDetails) await setContact({ email: null, phone: null, chatHours: null }, `TEST ${J} #1 clear the contact details`);
  try {
    const page = await visitor(browser);
    await page.goto('/help');
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'How can we help?' })).toBeVisible();
    await expect(main.getByLabel('Search answers')).toBeVisible();
    await expect(main.getByRole('navigation', { name: 'Browse by topic' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Send a request' })).toBeVisible();
    const card = page.locator('aside[data-testid="contact-card"]');
    await expect(card.getByTestId('support-email-unset')).toContainText('Support email is not set.');
    await expect(card.getByTestId('support-phone-unset')).toHaveText('Support phone is not set.');
    // No address anywhere: no mail link, and no address text on the page, the old one included.
    await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
    const text = `${await main.innerText()}\n${await card.innerText()}`;
    expect(text).not.toMatch(/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/);
    if (found.email) expect(text).not.toContain(found.email);
    // Signed out, the request button asks for a sign-in in place; no mail draft stands in for the form.
    await main.getByRole('button', { name: 'Send a request' }).click();
    await expect(main.getByTestId('request-sign-in')).toBeVisible();
    await page.context().close();
  } finally {
    if (hadDetails)
      await setContact({ email: found.email, phone: found.phone, chatHours: found.chatHours }, `TEST ${J} #1 put the contact details back`);
  }
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
      await expect(main.locator('[data-testid="help__row"], [data-testid="help__body"]')).toHaveCount(0);
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
  await expect(page.locator('main [data-testid="help__row"]').first()).toBeVisible();
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
    const rows = main.getByTestId('help__row');
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
    await expect(main.getByTestId('help__row')).toHaveCount(1);
    await expect(main.getByTestId('help__row').locator('h2')).toHaveText(shown.title);
    await expect(main.getByText('An answer taken down')).toHaveCount(0);

    // The answer reads as text: the tag in the body is characters on the page and never runs.
    await main.getByRole('link', { name: `Read answer: ${shown.title}` }).click();
    await expect(main.getByRole('heading', { level: 1, name: shown.title })).toBeVisible();
    await expect(main.getByTestId('help__body')).toContainText('<script>window.__j01 = 1</script>');
    expect(await page.evaluate(() => window.__j01)).toBeUndefined();

    await page.goto(`/help/section/${empty.id}`);
    await expect(main.getByRole('heading', { level: 1, name: empty.name })).toBeVisible();
    await expect(main.getByText('No answers in this section')).toBeVisible();
    await expect(main.getByTestId('help__row')).toHaveCount(0);
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
    await signOutBrowser(page.context());

    await page.goto('/help');
    const main = page.locator('main');
    await main.getByRole('textbox', { name: 'Search answers' }).fill(word);
    await main.getByRole('button', { name: 'Search', exact: true }).click();
    const titles = main.getByTestId('help__row').locator('h2');
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
  let page = null;
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

    page = await visitor(browser);
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
    await expect(main.getByTestId('help__body')).toContainText('This <script>window.__j01lang = 1</script> is text.');
    expect(await page.evaluate(() => window.__j01lang)).toBeUndefined();

    // With no language offered, there is no picker and the answer reads as before.
    await setHelpCentre({ languages: null }, `TEST ${J} #5 offer no language`);
    await page.reload();
    await expect(main.getByRole('heading', { level: 1, name: answer.title })).toBeVisible();
    await expect(main.getByRole('combobox', { name: 'Article language' })).toHaveCount(0);
  } finally {
    await page?.context().close();
    await setHelpCentre({ languages: found.languages }, `TEST ${J} #5 put the languages back`);
    if (answer) await unpublish(answer.id, answer.revision);
    await saveCategory({ ...category, retired: true, reason: `TEST ${J} #5 retire the run's topic` });
  }
});

/**
 * The run's own topic and one answer in it, narrowed to an audience. `cleanup` is set before anything is made, so a step
 * that throws part-way still takes down what it made and retires the topic.
 */
async function narrowedAnswer(step, slug, audience, made) {
  const category = { id: `j01-${RUN}-${slug}`, name: `TEST ${J} ${RUN} ${slug}`, position: 9003, reason: `TEST ${J} ${step}` };
  const section = { id: `j01-${RUN}-${slug}1`, categoryId: category.id, name: `TEST ${slug} ${RUN}`, position: 0, reason: category.reason };
  made.cleanup = async () => {
    if (made.answer) await unpublish(made.answer.id, made.answer.revision);
    await saveCategory({ ...category, retired: true, reason: `TEST ${J} ${step} retire the run's topic` });
  };
  await saveCategory(category);
  await saveSection(section);
  made.word = `j01${slug}${RUN}`;
  made.answer = await publishText({
    id: `j01-${RUN}-${slug}-answer`,
    title: `TEST ${audience} answer ${made.word}`,
    body: `TEST Only for ${audience}: ${made.word} body text.`,
    language: 'en',
    sectionId: section.id,
    baseRevision: 0,
  });
  made.answer = await setAudience(made.answer.id, made.answer.revision, audience);
  return made;
}

test(`${J} #6 a link to a signed-in-only answer asks the visitor to sign in and shows no body`, async ({ browser }) => {
  const made = {};
  let page = null;
  try {
    const { answer, word } = await narrowedAnswer('#6', 'si', 'signed_in', made);
    page = await visitor(browser);
    const who = await signUp(page, 'j01a');
    await signOutBrowser(page.context());

    await page.goto(`/helpdetail?id=${answer.id}`);
    const main = page.locator('main');
    const prompt = main.getByTestId('help-sign-in');
    await expect(prompt).toBeVisible();
    await expect(main.getByText(word)).toHaveCount(0);
    await expect(main.getByTestId('help__body')).toHaveCount(0);

    // Signed in, the same link reads the answer.
    await prompt.getByRole('link').click();
    await page.fill('input[name=identifier]', who.email);
    await page.fill('input[name=password]', who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    // The prompt promised the address opens again after sign-in.
    await expect(page).toHaveURL(new RegExp(`/helpdetail\\?id=${answer.id}$`));
    await expect(main.getByRole('heading', { level: 1, name: answer.title })).toBeVisible();
    await expect(main.getByTestId('help__body')).toContainText(`${word} body text.`);
  } finally {
    await page?.context().close();
    await made.cleanup?.();
  }
});

test(`${J} #7 a staff-only answer reads as an address that never existed, and is absent from the list and the search`, async ({
  browser,
}) => {
  const made = {};
  let page = null;
  try {
    const { answer, word } = await narrowedAnswer('#7', 'st', 'staff', made);
    // A public answer beside it in the same section, so the section's list is not empty by chance.
    made.sibling = await publishText({
      id: `j01-${RUN}-st-public`,
      title: `TEST public answer beside the staff one ${RUN}`,
      body: 'TEST A public answer in the same section.',
      language: 'en',
      sectionId: `j01-${RUN}-st1`,
      baseRevision: 0,
    });
    page = await visitor(browser);
    const main = page.locator('main');
    // Signed out and then signed in as a customer: the staff answer and an id that never existed read the same.
    for (const signedIn of [false, true]) {
      if (signedIn) await signUp(page, 'j01b');
      const seen = [];
      for (const id of [answer.id, `j01-${RUN}-never-existed`]) {
        await page.goto(`/helpdetail?id=${id}`);
        await expect(main.getByRole('heading', { level: 1, name: 'No answer found' })).toBeVisible();
        // Signed in, the read runs again once the session's token is fresh: compare the page only once it holds still.
        const text = await settled(main);
        seen.push(text.replaceAll(id, '<id>'), await main.getByTestId('help-sign-in').count());
      }
      expect(seen[0]).toBe(seen[2]);
      expect(seen[1]).toBe(seen[3]);
      expect(seen[0]).not.toContain(word);

      await page.goto('/help');
      await expect(main.getByText('Published answers', { exact: false }).first()).toBeVisible();
      await expect(main.getByText(word)).toHaveCount(0);
      // The section that holds it lists the public answer beside it and not the staff one.
      await page.goto(`/help/section/j01-${RUN}-st1`);
      await expect(main.getByTestId('help__row').locator('h2')).toHaveText([made.sibling.title]);
      await expect(main.getByText(word)).toHaveCount(0);
      await page.goto('/help');
      await main.getByRole('textbox', { name: 'Search answers' }).fill(word);
      await main.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(main.getByText('No matches')).toBeVisible();
      await expect(main.getByTestId('help__row')).toHaveCount(0);
    }
  } finally {
    await page?.context().close();
    if (made.sibling) await unpublish(made.sibling.id, made.sibling.revision);
    await made.cleanup?.();
  }
});

test(`${J} #8 a "No" vote with a comment sent as a request: one confirmation, one request naming the answer, one vote; over the rate, refused`, async ({
  browser,
}) => {
  // Six answers of the run's own. The stack's TEST vote rate is 5 an hour per account (tooling/profiles/test-owner-values).
  const category = { id: `j01-${RUN}-fb`, name: `TEST ${J} ${RUN} feedback`, position: 9004, reason: `TEST ${J} #8` };
  const section = { id: `j01-${RUN}-fb1`, categoryId: category.id, name: `TEST feedback ${RUN}`, position: 0, reason: category.reason };
  const made = [];
  let page = null;
  await saveCategory(category);
  try {
    await saveSection(section);
    for (let n = 0; n < 6; n += 1)
      made.push(
        await publishText({
          id: `j01-${RUN}-fb-${n}`,
          title: `TEST Feedback answer ${n} ${RUN}`,
          body: `TEST Answer ${n} for the vote step.`,
          language: 'en',
          sectionId: section.id,
          baseRevision: 0,
        }),
      );
    const [first, ...rest] = made;
    page = await visitor(browser);
    const main = page.locator('main');
    const card = main.getByTestId('help-feedback');

    // Signed out, the card asks for a sign-in that comes back to this answer.
    const who = await signUp(page, 'j01f');
    await signOutBrowser(page.context());
    await page.goto(`/helpdetail?id=${first.id}`);
    await expect(main.getByRole('heading', { level: 1, name: first.title })).toBeVisible();
    await card.getByRole('link', { name: 'Sign in to rate' }).click();
    await page.fill('input[name=identifier]', who.email);
    await page.fill('input[name=password]', who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/helpdetail\\?id=${first.id}$`));

    // "No", a comment, "send this as a request": one confirmation and a link to the one request.
    const comment = `TEST The steps in ${first.id} did not work for me`;
    await card.getByRole('button', { name: 'No', exact: true }).click();
    await card.getByLabel('What was missing? (optional)').fill(comment);
    await card.getByLabel('Send this as a support request').check();
    await card.getByRole('button', { name: 'Send', exact: true }).dblclick();
    const done = card.getByTestId('help-feedback-done');
    await expect(done).toHaveText(/your support request is open/);
    await expect(done).toHaveCount(1);
    // One request, whatever the double click sent: once nothing is in flight, the person's own list holds exactly one,
    // and it is the one linked.
    await page.waitForLoadState('networkidle');
    const listed = await (await api(who)).get(`/api/support/trpc/listMine?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
    expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
    const requests = listed.body.result.data;
    expect(requests).toHaveLength(1);
    const votes = async (id) => (await feedbackSummary()).filter((row) => row.articleId === id);
    expect(await votes(first.id)).toEqual([{ articleId: first.id, version: first.revision, helpful: 0, unhelpful: 1 }]);

    // The request's first message names the answer and carries the comment.
    await done.getByRole('link', { name: 'Open your request' }).click();
    await expect(page).toHaveURL(new RegExp(`/support/tickets/${requests[0].id}$`));
    await expect(page.locator('main').getByText(`This request is about help article ${first.id}`)).toBeVisible();
    await expect(page.locator('main').getByText(comment)).toBeVisible();

    // A second vote on the same version is answered with the first one and stored nothing.
    await page.goto(`/helpdetail?id=${first.id}`);
    await card.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(card.getByTestId('help-feedback-done')).toHaveText(/first vote stands/);
    expect(await votes(first.id)).toEqual([{ articleId: first.id, version: first.revision, helpful: 0, unhelpful: 1 }]);

    // Four more votes reach the rate; the next is refused in plain words and stored nothing.
    for (const answer of rest.slice(0, 4)) {
      await page.goto(`/helpdetail?id=${answer.id}`);
      await card.getByRole('button', { name: 'Yes', exact: true }).click();
      await expect(card.getByTestId('help-feedback-done')).toHaveText('Thank you. Your vote is kept.');
    }
    const over = rest[4];
    await page.goto(`/helpdetail?id=${over.id}`);
    await card.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(card).toContainText('You have rated many answers in a short time, so this vote was not kept.');
    expect(await votes(over.id)).toEqual([]);
  } finally {
    await page?.context().close();
    for (const row of made) await unpublish(row.id, row.revision);
    await saveCategory({ ...category, retired: true, reason: `TEST ${J} #8 retire the run's topic` });
  }
});

// Last in this serial file, so its red skips no other step. With the whole library empty, /help shows its honest empty
// state and no sample answer. That needs a stack whose catalogue is empty; on a shared stack other journeys' answers are
// published, so this clause of #3 stays red by name until the stack has that profile (lead ruling 2026-10-30 19:24).
test(`${J} #3 with the whole library empty, /help shows its honest empty state and no sample answer`, async ({ browser }) => {
  const listed = await fetch(`${EDGE}/api/support/trpc/listKb?input=${encodeURIComponent(JSON.stringify({ limit: 1 }))}`);
  expect(listed.status, 'listKb answers').toBe(200);
  const answers = (await listed.json()).result.data;
  if (answers.length > 0) throw new Error('the empty-library clause needs an empty-catalogue stack profile');
  const page = await visitor(browser);
  await page.goto('/help');
  await expect(page.locator('main').getByTestId('help__row')).toHaveCount(0);
  await expect(page.locator('main').getByText(/No answers are published/)).toBeVisible();
  await page.context().close();
});
