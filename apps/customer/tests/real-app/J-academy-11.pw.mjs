import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-academy-11, in the running app (docs/roadmap/journeys.json): a founder creates a course on the founder console's
// Academy desk and publishes it. One test per step, titled "J-academy-11 #<n>", run in order. The founder is the stack's
// LOCAL TEST founder A. Courses are kept on the stack, so each run's course has an address of its own.
const J = 'J-academy-11';
const RUN = Date.now().toString(36);
const SLUG = `test-j11-${RUN}`;
const TITLE = `TEST J-academy-11 course ${RUN}`;

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
