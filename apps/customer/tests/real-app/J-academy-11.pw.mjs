import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORIGIN, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-academy-11, in the running app (docs/roadmap/journeys.json): a founder creates a course on the founder console's
// Academy desk and publishes it. One test per step, titled "J-academy-11 #<n>", run in order. The founder is the stack's
// LOCAL TEST founder A. Courses are kept on the stack, so each run's course has an address of its own.
const J = 'J-academy-11';
const RUN = Date.now().toString(36);
const SLUG = `test-j11-${RUN}`;
const TITLE = `TEST J-academy-11 course ${RUN}`;
const VIDEO_FIXTURE = fileURLToPath(new URL('../../../../tooling/scripts/local-stack-fixtures/academy-test-video.webm', import.meta.url));
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

test(`${J} #4 a lesson's edits stay off learners until republished; revert makes a new revision; duplicate copies no learner record`, async ({
  browser,
}) => {
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to write in`);
  const page = await console_(browser);
  await page.goto(courseUrl);
  await page.getByRole('link', { name: 'Write Section 1 item 2', exact: true }).click();
  await page.waitForURL(/\/items\/[0-9a-f-]{36}$/);
  const lessonUrl = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { level: 1, name: 'TEST Position size', exact: true })).toBeVisible();
  const live = page.getByTestId('lesson-live');
  const liveRevision = page.getByTestId('lesson-live-revision');
  const outcome = page.getByTestId('course-desk-outcome');
  await expect(liveRevision).toHaveText('Nothing: no revision is published');

  // Revision 1: a text block and a code block, published to learners with a reason.
  await page.getByRole('button', { name: 'Add block' }).click();
  await page.getByLabel('Block 1 text', { exact: true }).fill('TEST Risk one percent of the account per trade.');
  await page.getByRole('combobox', { name: 'New block type', exact: true }).selectOption('code');
  await page.getByRole('button', { name: 'Add block' }).click();
  await page.getByLabel('Block 2 code', { exact: true }).fill('size = account * 0.01 / stop_distance');
  await page.getByLabel('Block 2 language', { exact: true }).fill('python');
  await page.getByRole('button', { name: 'Save lesson' }).click();
  await expect(outcome).toContainText('Done: lesson saved');
  await expect(page.getByTestId('lesson-revision-1')).toContainText('Revision 1: saved');
  await page.getByLabel('Reason', { exact: true }).fill('TEST first cut');
  await page.getByRole('button', { name: 'Publish revision 1 to learners' }).click();
  await expect(outcome).toContainText('Done: published to learners');
  await expect(liveRevision).toHaveText('Revision 1');
  await expect(live).toContainText('one percent');

  // Revision 2 is saved while learners keep revision 1, until it is published.
  await page.getByLabel('Block 1 text', { exact: true }).fill('TEST Risk half a percent while you learn.');
  await page.getByRole('button', { name: 'Save lesson' }).click();
  await expect(page.getByTestId('lesson-revision-2')).toContainText('Revision 2: saved');
  await expect(liveRevision).toHaveText('Revision 1');
  await expect(live).toContainText('one percent');
  await expect(live).not.toContainText('half a percent');
  await page.getByRole('button', { name: 'Publish revision 2 to learners' }).click();
  await expect(liveRevision).toHaveText('Revision 2');
  await expect(live).toContainText('half a percent');

  // Revert to revision 1 makes revision 3 with its words; learners keep revision 2 until the next publish.
  await page.getByRole('button', { name: 'Revert to revision 1' }).click();
  await expect(outcome).toContainText('Done: reverted');
  await expect(page.getByTestId('lesson-revision-3')).toContainText('Revision 3: reverted from revision 1');
  await expect(page.getByLabel('Block 1 text', { exact: true })).toHaveValue('TEST Risk one percent of the account per trade.');
  await expect(page.getByTestId('lesson-revision-2')).toBeVisible();
  await expect(liveRevision).toHaveText('Revision 2');
  await page.reload();
  await expect(liveRevision).toHaveText('Revision 2');

  // Duplicate: the copy holds the newest words as its own revision 1, and nothing is live for learners on it.
  await page.getByRole('button', { name: 'Duplicate this item' }).click();
  await page.waitForURL((url) => /\/items\/[0-9a-f-]{36}$/.test(url.pathname) && url.pathname !== lessonUrl);
  await expect(page.getByTestId('lesson-revision-1')).toContainText('Revision 1: duplicated from another item');
  await expect(page.getByTestId('lesson-revisions').locator('li')).toHaveCount(1);
  await expect(liveRevision).toHaveText('Nothing: no revision is published');
  await expect(page.getByLabel('Block 1 text', { exact: true })).toHaveValue('TEST Risk one percent of the account per trade.');

  // On the course: the copy sits right after its source, and the history names the lesson publish.
  await page.goto(courseUrl);
  const titles = await page
    .getByTestId('outline-section-0')
    .locator('[data-testid^="outline-item-"] input[aria-label$="title"]')
    .evaluateAll((els) => els.map((e) => e.value));
  expect(titles).toEqual(['TEST Part 1', 'TEST Position size', 'TEST Position size', 'TEST Stops']);
  await expect(page.getByTestId('outline-item-0-1')).toContainText('revision 3, learners see 2');
  await expect(page.getByTestId('outline-item-0-2')).toContainText('revision 1, not published');
  await expect(page.getByTestId('course-history')).toContainText('a lesson published to learners');
  await page.context().close();
});

test(`${J} #5 a lesson file over the size limit is refused before it is read; an unknown block is listed and nothing is created`, async ({
  browser,
}) => {
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to import into`);
  const page = await console_(browser);
  await page.goto(courseUrl);
  await page.getByRole('link', { name: 'Write Section 1 item 2', exact: true }).click();
  await page.waitForURL(/\/items\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('lesson-import-limit')).toContainText('Up to 8192 bytes');
  const revisions = page.getByTestId('lesson-revisions').locator('li');
  const before = await revisions.count();
  const outcome = page.getByTestId('course-desk-outcome');
  const sent = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/academy-lessons')) sent.push(r.url());
  });
  const lessonFile = (name, blocks) => ({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ format: 'intafaced.lesson.v1', blocks })),
  });

  // 20 KiB against the stack's TEST limit of 8 KiB: refused by name before a byte is read or sent.
  const big = lessonFile('TEST-big.json', [{ type: 'text', markdown: `TEST ${'x'.repeat(20_000)}` }]);
  await page.getByLabel('Lesson file', { exact: true }).setInputFiles(big);
  await page.getByRole('button', { name: 'Import file' }).click();
  await expect(outcome).toHaveAttribute('data-code', 'academy.import_too_large');
  await expect(outcome).toContainText('The file is over the size limit');
  expect(sent).toEqual([]);
  await expect(revisions).toHaveCount(before);

  // An unknown block type: svc-academy lists it by its place in the file, and nothing is created.
  const unknown = lessonFile('TEST-unknown.json', [
    { type: 'text', markdown: 'TEST fine' },
    { type: 'iframe', src: 'https://example.com/embed' },
  ]);
  await page.getByLabel('Lesson file', { exact: true }).setInputFiles(unknown);
  await page.getByRole('button', { name: 'Import file' }).click();
  await expect(outcome).toHaveAttribute('data-code', 'academy.import_invalid');
  await expect(page.getByTestId('lesson-import-report')).toContainText('Block 2: unknown block type "iframe"');
  await expect(revisions).toHaveCount(before);
  await page.reload();
  await expect(revisions).toHaveCount(before);

  // A good file becomes the next revision, and learners keep the published one.
  const good = lessonFile('TEST-good.json', [{ type: 'text', markdown: 'TEST Imported words.' }]);
  await page.getByLabel('Lesson file', { exact: true }).setInputFiles(good);
  await page.getByRole('button', { name: 'Import file' }).click();
  await expect(outcome).toContainText('Done: imported');
  await expect(page.getByTestId(`lesson-revision-${before + 1}`)).toContainText(`Revision ${before + 1}: imported`);
  await expect(page.getByTestId('lesson-live-revision')).toHaveText('Revision 2');
  await page.context().close();
});

test(`${J} #6 Draft with no model provider gives the template draft and an owner-decision notice; nothing goes live until accepted`, async ({
  browser,
}) => {
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to draft`);
  const page = await console_(browser);
  await page.goto(courseUrl);
  await page.getByRole('link', { name: 'Write Section 1 item 2', exact: true }).click();
  await page.waitForURL(/\/items\/[0-9a-f-]{36}$/);
  const outcome = page.getByTestId('course-desk-outcome');
  const revisions = page.getByTestId('lesson-revisions').locator('li');
  const before = await revisions.count();
  const liveRevision = page.getByTestId('lesson-live-revision');
  const liveBefore = await liveRevision.innerText();

  // The model path: no provider is chosen, so it waits for the owner, by name, and nothing is drafted.
  await page.getByRole('button', { name: 'Draft with a model' }).click();
  await expect(outcome).toHaveAttribute('data-code', 'owner.decision');
  await expect(outcome).toContainText('Waiting for an owner decision');
  await expect(page.getByTestId('lesson-draft')).toHaveText('No draft is waiting.');

  // The template path: headings from the course's own structure, shown as a draft that is not live.
  await page.getByRole('button', { name: 'Draft from the template' }).click();
  await expect(outcome).toContainText('Done: draft ready to review');
  const draft = page.getByTestId('lesson-draft');
  await expect(draft).toContainText('Draft, not live');
  await expect(draft).toContainText('# TEST Position size');
  await expect(draft).toContainText(`in “${TITLE}”`);
  await expect(revisions).toHaveCount(before);
  await expect(liveRevision).toHaveText(liveBefore);

  // Accepting is the person's step: a new revision by them; learners still see the published one.
  await page.getByRole('button', { name: 'Accept draft' }).click();
  await expect(outcome).toContainText('Done: draft decided');
  await expect(page.getByTestId(`lesson-revision-${before + 1}`)).toContainText(`Revision ${before + 1}: accepted from an assistant draft`);
  await expect(page.getByTestId('lesson-draft')).toHaveText('No draft is waiting.');
  await expect(liveRevision).toHaveText(liveBefore);
  await page.context().close();
});

/** Academy restarted with the owner's upload limits blank, or back on the stack's TEST limits. */
function academyUploadLimits(on) {
  const before = process.env.LOCAL_STACK_ACADEMY_UPLOAD_LIMITS;
  if (on) delete process.env.LOCAL_STACK_ACADEMY_UPLOAD_LIMITS;
  else process.env.LOCAL_STACK_ACADEMY_UPLOAD_LIMITS = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'academy');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_ACADEMY_UPLOAD_LIMITS;
    else process.env.LOCAL_STACK_ACADEMY_UPLOAD_LIMITS = before;
  }
}

test(`${J} #7 a video, an SRT file and a handout upload; blank limits refuse; too large is refused unsent; a bad subtitle line is shown; a handout that is not its type is refused`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to upload to`);
  const page = await console_(browser);
  await page.goto(courseUrl);
  await page.getByRole('link', { name: 'Write Section 1 item 2', exact: true }).click();
  await page.waitForURL(/\/items\/[0-9a-f-]{36}$/);
  const limits = page.getByTestId('media-limits');
  const outcome = page.getByTestId('media-outcome');
  const uploads = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/academy-media/upload')) uploads.push(r.url());
  });
  const video = { name: 'TEST-sizing.webm', mimeType: 'video/webm', buffer: readFileSync(VIDEO_FIXTURE) };
  const uploadVideo = async (file) => {
    await page.getByLabel('Video file', { exact: true }).setInputFiles(file);
    await page.getByRole('button', { name: 'Upload video' }).click();
  };

  // With the owner's upload limits blank, nothing is uploaded, and the page says why before sending anything.
  academyUploadLimits(false);
  try {
    await page.reload();
    await expect(limits).toContainText('Not set by the owner: nothing is uploaded');
    await uploadVideo(video);
    await expect(outcome).toContainText('The upload limits are not set');
    expect(uploads).toEqual([]);
  } finally {
    academyUploadLimits(true);
  }
  await page.reload();
  await expect(limits).toContainText('1048576 bytes');
  await expect(limits).toContainText('video/webm');

  // 2 MiB against the stack's TEST limit of 1 MiB: refused here, and no byte is sent.
  await uploadVideo({ name: 'TEST-big.webm', mimeType: 'video/webm', buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
  await expect(outcome).toContainText('The file is over the size limit');
  expect(uploads).toEqual([]);

  // The TEST video goes to the stack's own store and svc-academy reads it back before it counts.
  await uploadVideo(video);
  await expect(outcome).toContainText('Done: checked and stored');
  await expect(page.getByTestId('media-file-video')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('media-file-video')).toContainText('TEST-sizing.webm');

  // Subtitles: a malformed line is named and nothing is stored; a good SRT file is stored with its cues.
  const srt = (stamp) =>
    Buffer.from(`1\n00:00:01,000 --> 00:00:03,000\nTEST Size the position first.\n\n2\n${stamp} --> 00:00:06,000\nTEST Then the stop.\n`);
  const addCaptions = async (buffer) => {
    await page.getByLabel('Caption file', { exact: true }).setInputFiles({ name: 'TEST-en.srt', mimeType: 'application/x-subrip', buffer });
    await page.getByRole('button', { name: 'Add captions' }).click();
  };
  await addCaptions(srt('00:00:04.000'));
  await expect(outcome).toHaveAttribute('data-code', 'academy.captions_invalid');
  await expect(outcome).toContainText('line 6: "00:00:04.000" is not an SRT timestamp');
  await expect(page.getByTestId('media-captions')).toContainText('No captions yet');
  await addCaptions(srt('00:00:04,000'));
  await expect(outcome).toContainText('Done: captions saved');
  await expect(page.getByTestId('media-captions')).toContainText('English (en, SRT): 2 cues, first “TEST Size the position first.”');

  // A handout declared PDF whose bytes are a PNG image: stored, read back, refused by name, and never offered.
  const handout = async (file) => {
    await page.getByLabel('Handout file', { exact: true }).setInputFiles(file);
    await page.getByRole('button', { name: 'Upload handout' }).click();
  };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  await handout({ name: 'TEST-sheet.pdf', mimeType: 'application/pdf', buffer: png });
  await expect(outcome).toHaveAttribute('data-code', 'academy.file_type_mismatch');
  await expect(outcome).toContainText('The file is not what it says it is');
  const refused = page.getByTestId('media-file-handout').filter({ hasText: 'TEST-sheet.pdf' });
  await expect(refused).toHaveAttribute('data-state', 'refused');
  await expect(refused).toContainText('declared application/pdf but its content is image/png');
  await expect(refused.getByRole('link')).toHaveCount(0);

  // A real PDF handout is checked and stored.
  await handout({ name: 'TEST-handout.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% TEST handout\n%%EOF\n') });
  await expect(outcome).toContainText('Done: checked and stored');
  await expect(page.getByTestId('media-file-handout').filter({ hasText: 'TEST-handout.pdf' })).toHaveAttribute('data-state', 'ready');
  await page.context().close();
});

test(`${J} #8 a lesson featured on the Learn hub fills the slot and leaves it when withdrawn; a topic named like a tab is refused`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to feature`);
  const page = await console_(browser);
  const outcome = page.getByTestId('course-desk-outcome');
  await page.goto(courseUrl);
  await page.getByRole('link', { name: 'Write Section 1 item 2', exact: true }).click();
  await page.waitForURL(/\/items\/[0-9a-f-]{36}$/);
  const lessonUrl = page.url();
  const featuredNote = page.getByTestId('lesson-featured');
  await expect(featuredNote).toContainText('Learners can read it, so it can be featured');

  // Featured from the lesson's page: the hub desk's slot shows it, with who and why.
  await page.getByLabel('Why feature it', { exact: true }).fill('TEST first article for new learners');
  await page.getByRole('button', { name: 'Feature on the Learn hub' }).click();
  await expect(outcome).toContainText('Done: featured on the Learn hub');
  await expect(featuredNote).toContainText('This lesson is the Learn hub’s featured article.');
  await page.goto('/academy-ops/catalogue/featured');
  const slot = page.getByTestId('hub-featured');
  await expect(slot).toContainText('TEST Position size');
  await expect(slot).toContainText(TITLE);
  await expect(slot).toContainText('TEST first article for new learners');
  // The customer Learn hub, signed out: its Featured slot shows the lesson and its course. The course is a draft, so the
  // slot says there is no course page to open yet rather than linking to one.
  const visitor = await (await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } })).newPage();
  await visitor.goto('/academy');
  const learnHub = visitor.locator('[data-academy-hub="true"]');
  const featuredLesson = learnHub.locator('[data-featured-lesson="true"]');
  await expect(featuredLesson.getByRole('heading', { level: 3 })).toHaveText('TEST Position size');
  await expect(featuredLesson).toContainText(`A lesson from the course ${TITLE}.`);
  await expect(featuredLesson).toContainText('Its course is a draft, closed to learners, so there is no course page to open.');
  await expect(featuredLesson.getByRole('link')).toHaveCount(0);

  // Withdrawn from learners: it leaves the slot in the same step.
  await page.goto(lessonUrl);
  await page.getByLabel('Why withdraw it', { exact: true }).fill('TEST rewriting the opening');
  await page.getByRole('button', { name: 'Withdraw from learners' }).click();
  await expect(outcome).toContainText('Done: withdrawn from learners');
  await expect(page.getByTestId('lesson-live-revision')).toHaveText('Nothing: no revision is published');
  await expect(featuredNote).toContainText('Not featured. Only a lesson learners can read is featured.');
  await page.goto('/academy-ops/catalogue/featured');
  await expect(slot).toHaveText('Nothing is featured. Feature a lesson learners can read from that lesson’s page.');
  // It has left the customer Learn hub too.
  await visitor.reload();
  await expect(learnHub.locator('[data-featured-lesson="true"]')).toHaveCount(0);
  await expect(learnHub.getByText('Nothing is featured yet.')).toBeVisible();
  await visitor.context().close();

  // The lesson goes back to learners for the steps after this one.
  await page.goto(lessonUrl);
  await page.getByLabel('Reason', { exact: true }).fill('TEST back for learners');
  await page.getByRole('button', { name: /^Publish revision \d+ to learners$/ }).click();
  await expect(outcome).toContainText('Done: published to learners');

  // Topics: a tab's address is refused by name; a topic of its own is added and the course is filed under it.
  await page.goto('/academy-ops/catalogue/featured');
  const addTopic = async (name, address) => {
    await page.getByLabel('Topic name', { exact: true }).fill(name);
    await page.getByLabel('Topic address', { exact: true }).fill(address);
    await page.getByRole('button', { name: 'Add topic' }).click();
  };
  await addTopic('Learning', 'learning');
  await expect(outcome).toHaveAttribute('data-code', 'academy.slug_reserved');
  await expect(outcome).toContainText('That address is an Academy tab');
  const topic = `TEST Risk ${RUN}`;
  await addTopic(topic, `test-risk-${RUN}`);
  await expect(outcome).toContainText('Done: topic added');
  await expect(page.getByTestId('hub-topics')).toContainText(topic);

  await page.goto(courseUrl);
  await expect(page.getByTestId('course-topics')).toHaveText('Filed under no topic.');
  await page.getByRole('checkbox', { name: topic, exact: true }).check();
  await page.getByRole('button', { name: 'Save topics' }).click();
  await expect(outcome).toContainText('Done: topics saved');
  await expect(page.getByTestId('course-topics')).toHaveText(`Filed under: ${topic}.`);
  await expect(page.getByTestId('course-history')).toContainText('filed under topics');
  await expect(page.getByTestId('course-history')).toContainText('a lesson withdrawn from learners');
  await page.context().close();
});

test(`${J} #9 Preview as new learner shows the real syllabus with locks and records nothing; a private link opens the unlisted page and a revoked one is not found`, async ({
  browser,
}) => {
  test.setTimeout(180_000);
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to preview`);
  const page = await console_(browser);
  await page.goto(courseUrl);
  const history = page.getByTestId('course-history');
  const before = await history.innerText();

  // Preview as new learner: the stored syllabus, each item with its lock; nothing is recorded.
  await page.getByRole('link', { name: 'Preview as new learner', exact: true }).click();
  await page.waitForURL(/\/preview$/);
  await expect(page.getByTestId('preview-note')).toContainText('Opening it records nothing');
  const syllabus = page.getByTestId('preview-syllabus');
  const item = (title) => syllabus.locator('li[data-lock]').filter({ hasText: title }).first();
  // The course is still a draft, so a released item is locked because nobody can enrol yet.
  await expect(item('TEST Position size')).toHaveAttribute('data-lock', 'enrolment_closed');
  await expect(item('TEST Position size')).toContainText('enrolment is closed while the course is not published');
  await expect(item('TEST Check yourself')).toHaveAttribute('data-lock', 'not_released');
  await expect(item('TEST Reading list')).toHaveAttribute('data-lock', 'enrolment_closed');
  await expect(item('TEST Part 1')).toHaveAttribute('data-lock', 'none');
  await page.goto(courseUrl);
  await expect(history).toHaveText(before);

  // A private link, made with a reason: its address is shown once and opens the unlisted page signed out.
  const links = page.locator('section', { has: page.getByRole('heading', { name: 'Learners’ view' }) });
  await expect(links.getByTestId('course-links')).toHaveText('No private links.');
  await links.getByLabel('Why make a link', { exact: true }).fill('TEST reviewer copy');
  await links.getByRole('button', { name: 'Make a private link' }).click();
  await expect(links.getByTestId('course-desk-outcome')).toContainText('Done: private link made');
  const path = (await links.getByTestId('link-made').locator('code').innerText()).trim();
  expect(path).toMatch(new RegExp(`^/academy/learning/course/${SLUG}#key=[A-Za-z0-9_-]{43}$`));
  await expect(links.getByTestId('course-links').locator('li[data-state="open"]')).toContainText('TEST reviewer copy');

  const visitor = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await visitor.goto(path);
  const unlisted = visitor.locator(`[data-academy-linked-course="${SLUG}"]`);
  await expect(unlisted).toContainText(TITLE);
  await expect(unlisted).toContainText('You opened this course through a private link');
  await expect(unlisted.locator('li[data-lock]').filter({ hasText: 'TEST Position size' }).first()).toContainText(
    'Locked: enrolment is closed',
  );
  await expect(unlisted).toContainText('This course is unpublished, so enrolment is closed.');
  await expect(unlisted.locator('li[data-lock="not_released"]').filter({ hasText: 'TEST Check yourself' })).toContainText('Unreleased');

  // Revoked with a reason: the same address is not found, the same as a course that does not exist.
  await links.getByLabel('Why revoke it', { exact: true }).fill('TEST review done');
  await links.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(links.getByTestId('course-desk-outcome')).toContainText('Done: link revoked');
  await expect(links.getByTestId('course-links').locator('li[data-state="revoked"]')).toContainText('TEST review done');
  await visitor.reload();
  await expect(visitor.getByText('There is no published course at this address.')).toBeVisible();
  await expect(unlisted).toHaveCount(0);
  await expect(history).toHaveText(before);
  await visitor.context().close();
  await page.context().close();
});

test(`${J} #10 published, the course is in the public catalogue and a learner enrols on the free track while the paid track stays closed in words`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  if (!courseUrl) throw new Error(`${J}: #2 left no course, so this step has nothing to publish`);
  const page = await console_(browser);
  await page.goto(courseUrl);
  await page.getByLabel('Reason', { exact: true }).fill('TEST open to learners');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByTestId('course-desk-outcome').first()).toContainText('Done');
  await expect(page.getByTestId('course-history')).toContainText('moved to published');
  await page.context().close();

  // Signed out, the public catalogue lists it and its page shows the real syllabus, locked until enrolment.
  const visitor = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await visitor.goto('/academy/learning');
  const card = visitor.locator('[data-academy-authored-cards] li').filter({ hasText: TITLE });
  await expect(card).toContainText('25.5 USDT');
  await card.getByRole('link', { name: TITLE, exact: true }).click();
  const course = visitor.locator(`[data-academy-authored-course="${SLUG}"]`);
  await expect(course.locator('li[data-lock]').filter({ hasText: 'TEST Position size' }).first()).toHaveAttribute('data-lock', 'enrol');
  await expect(course).toContainText('Locked until you enrol');
  await expect(course.getByRole('link', { name: 'Sign in to enrol' })).toBeVisible();
  await visitor.context().close();

  // A verified learner enrols on the free track; the paid track is closed because course payments are off.
  const learner = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = await signUp(learner, 'j11');
  await verify(learner, who);
  await signIn(learner, who);
  await learner.goto(`/academy/learning/course/${SLUG}`);
  const block = learner.locator(`[data-academy-enrol="${SLUG}"]`);
  await expect(block.getByRole('radio', { name: /Free track/ })).toBeChecked();
  await expect(block.getByRole('radio', { name: /Certificate track/ })).toBeDisabled();
  await expect(block.getByText('Course payments are switched off, so this paid track is closed for enrolment.')).toBeVisible();
  await block.getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(block.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  const enrolled = learner.locator(`[data-academy-authored-course="${SLUG}"]`);
  await expect(enrolled.locator('li[data-lock]').filter({ hasText: 'TEST Position size' }).first()).toHaveAttribute('data-lock', 'none');
  await learner.reload();
  await expect(block.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  await learner.context().close();
});
