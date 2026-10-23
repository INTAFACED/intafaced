import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tool } from './stack.mjs';

// J-academy-11, in the running app (docs/roadmap/journeys.json): a founder creates a course on the founder console's
// Academy desk and publishes it. One test per step, titled "J-academy-11 #<n>", run in order. The founder is the stack's
// LOCAL TEST founder A. Courses are kept on the stack, so each run's course has an address of its own.
const J = 'J-academy-11';
const RUN = Date.now().toString(36);
const SLUG = `test-j11-${RUN}`;
const TITLE = `TEST J-academy-11 course ${RUN}`;
/** The course #2 creates, for the steps after it (serial, one worker). */
let courseUrl = null;

test.describe.configure({ mode: 'serial' });

/** Founder A on the console, in a context of its own. */
async function console_(browser) {
  const context = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await founderSignIn(page, 'a');
  return page;
}

const SECTIONS = [
  { href: '/academy-ops/catalogue', heading: 'Academy: catalogue', read: 'academy.courses' },
  { href: '/academy-ops/certificates', heading: 'Academy: certificates', read: 'academy.cert-defs' },
  { href: '/academy-ops/programmes', heading: 'Academy: programmes', read: 'academy.seasons' },
  { href: '/academy-ops/ambassadors', heading: 'Academy: ambassadors', read: 'academy.ambassadors' },
  { href: '/academy-ops/grants', heading: 'Academy: grants', read: 'academy.grant-audit' },
];

test(`${J} #1 the Academy desk has catalogue, certificates, programmes, ambassadors and grants as separate routes with real reads`, async ({
  browser,
}) => {
  const page = await console_(browser);
  await page.goto('/academy-ops');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  for (const s of SECTIONS) await expect(nav.locator(`a[href="${s.href}"]`)).toBeVisible();

  for (const s of SECTIONS) {
    await page.goto(s.href);
    await expect(page.getByRole('heading', { level: 1, name: s.heading, exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' }).locator(`a[href="${s.href}"]`)).toHaveAttribute('aria-current', 'page');
    // Exactly one section on its page, and every read on it answered: a count, rows, or the honest empty sentence.
    await expect(page.locator('[data-testid^="section-"]')).toHaveCount(1);
    const chip = page.getByText(/\d+ of \d+ reads answered/);
    const [answered, total] = (await chip.innerText()).match(/\d+/g).map(Number);
    expect(answered, `${s.href}: ${await chip.innerText()}`).toBe(total);
    await expect(page.getByTestId(`read-${s.read}`)).toBeVisible();
  }

  // The catalogue counts the courses staff created, by state, as svc-academy reports them.
  await page.goto('/academy-ops/catalogue');
  const courses = page.getByTestId('read-academy.courses');
  await expect(courses.getByText('Drafts', { exact: true })).toBeVisible();
  await expect(courses.getByText('Published', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Courses', exact: true }).first()).toHaveAttribute('href', '/academy-ops/catalogue/courses');
  // Grants: rows from svc-academy, or its own empty sentence; never a "not available" line.
  await page.goto('/academy-ops/grants');
  await expect(page.getByText('Not available:')).toHaveCount(0);
  await page.context().close();
});

test(`${J} #2 a course saves as a draft; an Academy tab as its address is refused; a paid course with no price refuses to publish`, async ({
  browser,
}) => {
  const page = await console_(browser);
  await page.goto('/academy-ops/catalogue/courses');
  await expect(page.getByRole('heading', { level: 1, name: 'Courses', exact: true })).toBeVisible();
  const counts = page.getByTestId('course-counts');
  await expect(counts).toBeVisible();
  const draftsBefore = Number((await counts.getByText(/^Draft: \d+$/).innerText()).match(/\d+/)[0]);

  // An Academy tab as the address is refused by name, and nothing is created.
  await page.getByLabel('Title', { exact: true }).fill(TITLE);
  await page.getByLabel('Address', { exact: true }).fill('videos');
  await page.getByRole('button', { name: 'Create draft' }).click();
  const outcome = page.getByTestId('course-desk-outcome');
  await expect(outcome).toHaveAttribute('data-code', 'academy.slug_reserved');
  await expect(outcome).toContainText('That address is an Academy tab');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(counts.getByText(`Draft: ${draftsBefore}`, { exact: true })).toBeVisible();

  // A paid course with a thumbnail and no price saves as a draft.
  await page.getByLabel('Address', { exact: true }).fill(SLUG);
  await page.getByLabel('Summary', { exact: true }).fill('TEST A course this journey creates.');
  await page.getByLabel('Thumbnail address', { exact: true }).fill('https://example.com/test-thumbnail.png');
  await page.getByLabel('Paid', { exact: true }).check();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForURL(/\/academy-ops\/catalogue\/courses\/[0-9a-f-]{36}$/);
  courseUrl = new URL(page.url()).pathname;
  const facts = page.getByTestId('course-facts');
  await expect(page.getByRole('heading', { level: 1, name: TITLE, exact: true })).toBeVisible();
  await expect(facts).toContainText('Draft');
  await expect(facts).toContainText(SLUG);
  await expect(page.getByTestId('course-price')).toHaveText('Paid, no price set');
  await expect(page.getByAltText('Course thumbnail')).toHaveAttribute('src', 'https://example.com/test-thumbnail.png');
  await expect(page.getByTestId('course-history')).toContainText('created as a draft (revision 1)');

  // Publishing it refuses by name, and the course stays a draft at the same revision.
  await page.getByLabel('Reason', { exact: true }).fill('TEST ready for learners');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(outcome).toHaveAttribute('data-code', 'academy.price_unset');
  await expect(outcome).toContainText('A paid course needs a price');
  await expect(facts).toContainText('Draft');
  await expect(page.getByTestId('course-history').locator('li')).toHaveCount(1);

  // With a price it saves at the next revision; publishing then stops at the empty outline, again by name.
  await page.getByLabel('Price', { exact: true }).fill('25.50');
  await page.getByLabel('Asset', { exact: true }).fill('USDT');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('course-price')).toHaveText('25.5 USDT');
  await expect(page.getByTestId('course-history')).toContainText('details saved (revision 2)');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(outcome).toHaveAttribute('data-code', 'academy.course_outline_empty');
  await expect(facts).toContainText('Draft');

  // The list shows it, and the draft count went up by one.
  await page.goto('/academy-ops/catalogue/courses');
  await expect(page.getByTestId(`course-${SLUG}`)).toContainText('25.5 USDT');
  await expect(counts.getByText(`Draft: ${draftsBefore + 1}`, { exact: true })).toBeVisible();
  await page.context().close();
});

/** Academy restarted with the owner's outline limits blank, or back on the stack's TEST limits. */
function academyOutlineLimits(on) {
  const before = process.env.LOCAL_STACK_ACADEMY_OUTLINE_LIMITS;
  if (on) delete process.env.LOCAL_STACK_ACADEMY_OUTLINE_LIMITS;
  else process.env.LOCAL_STACK_ACADEMY_OUTLINE_LIMITS = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'academy');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_ACADEMY_OUTLINE_LIMITS;
    else process.env.LOCAL_STACK_ACADEMY_OUTLINE_LIMITS = before;
  }
}

test(`${J} #3 the outline holds ordered sections of typed items; with the section limits blank the save is refused`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to build`);
  const page = await console_(browser);
  await page.goto(courseUrl);
  await expect(page.getByTestId('outline-limits')).toContainText('sections 20, items 200');

  // Two sections: a subheader and two lessons (one indented), then a quiz and a link.
  await page.getByLabel('New section', { exact: true }).fill('Start here');
  await page.getByRole('button', { name: 'Add section' }).click();
  await page.getByLabel('New section', { exact: true }).fill('Practice');
  await page.getByRole('button', { name: 'Add section' }).click();
  const add = async (si, kind, title, { indent = 0, url } = {}) => {
    await page.getByRole('button', { name: `Add item to section ${si + 1}` }).click();
    const n = await page.getByTestId(`outline-section-${si}`).locator('[data-testid^="outline-item-"]').count();
    const name = `Section ${si + 1} item ${n}`;
    await page.getByRole('combobox', { name: `${name} type`, exact: true }).selectOption(kind);
    await page.getByLabel(`${name} title`, { exact: true }).fill(title);
    if (url) await page.getByLabel(`${name} address`, { exact: true }).fill(url);
    for (let i = 0; i < indent; i++) await page.getByRole('button', { name: `Indent ${name}`, exact: true }).click();
  };
  await add(0, 'subheader', 'TEST Part 1');
  await add(0, 'lesson', 'TEST Position size');
  await add(0, 'lesson', 'TEST Stops', { indent: 1 });
  await add(1, 'quiz', 'TEST Check yourself');
  await add(1, 'link', 'TEST Reading list', { url: 'https://example.com/reading' });
  await page.getByRole('button', { name: 'Save outline' }).click();
  const outcome = page.getByTestId('course-desk-outcome');
  await expect(outcome).toContainText('Done: outline saved');
  await expect(page.getByTestId('course-history')).toContainText('outline saved (revision 3)');

  // What svc-academy stored, in order: four items to open (the subheader is a label), the indent kept.
  await page.reload();
  await expect(page.getByTestId('course-facts')).toContainText('Items in the outline4');
  const titles = await page
    .locator('[data-testid^="outline-item-"] input[aria-label$="title"]')
    .evaluateAll((els) => els.map((e) => e.value));
  expect(titles).toEqual(['TEST Part 1', 'TEST Position size', 'TEST Stops', 'TEST Check yourself', 'TEST Reading list']);
  await expect(page.getByRole('combobox', { name: 'Section 2 item 1 type', exact: true })).toHaveValue('quiz');
  await expect(page.getByTestId('outline-item-0-2')).toHaveAttribute('style', /margin-left: ?24px/);

  // With the owner's section limits blank, the next save is refused by name and the outline stays as it was.
  academyOutlineLimits(false);
  try {
    await page.reload();
    await expect(page.getByTestId('outline-limits')).toContainText('sections not set, items not set');
    await add(1, 'discussion', 'TEST Questions');
    await page.getByRole('button', { name: 'Save outline' }).click();
    await expect(outcome).toHaveAttribute('data-code', 'academy.outline_limits_unset');
    await expect(outcome).toContainText('The outline limits are not set');
    // The refused edit is still on the page to save later; what svc-academy holds is unchanged.
    await expect(page.getByLabel('Section 2 item 3 title', { exact: true })).toHaveValue('TEST Questions');
    await expect(page.getByTestId('course-facts')).toContainText('Items in the outline4');
  } finally {
    academyOutlineLimits(true);
  }
  await page.context().close();
});
