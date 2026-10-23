import { test, expect } from '@playwright/test';
import { draftNotice, publishNotice, publishedNotices } from './notices.mjs';
import { statusRead } from './status-page.mjs';
import { EDGE, ORIGIN } from './stack.mjs';

// J-support-public-09, in the running app (docs/roadmap/journeys.json): a developer reads status and notices through the
// documented API and sends a comment from code. Tests titled "J-support-public-09 #<n>" prove a whole step. The API is
// called the way a developer's code calls it: plain HTTP to Edge, with no session and no cookie.
const J = 'J-support-public-09';
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

/** A signed-out GET of the read API through Edge, as JSON. */
async function readApi(path) {
  const res = await fetch(`${EDGE}/api/notify/v1${path}`, { headers: { accept: 'application/json' } });
  return { status: res.status, body: await res.json() };
}

test(`${J} #1 the notices read without a key: the same data as the website, paged`, async ({ browser }) => {
  // Three announcements of this run, published by the stack's TEST founders (draft, second-founder approval, publish).
  const mine = [];
  for (const n of [1, 2, 3]) {
    const row = await draftNotice({
      kind: 'announcement',
      title: `TEST journey ${J} ${RUN} notice ${n}`,
      body: 'TEST An announcement a developer reads through the API.',
      minutes: 5,
      key: `${J}:${RUN}:${n}`,
    });
    mine.push((await publishNotice(row, `${J}:${RUN}:${n}`)).id);
  }

  // No page size is assumed: without one the read refuses and names why.
  expect(await readApi('/notices?kind=announcement')).toEqual({ status: 400, body: { code: 'notify.notices_limit_invalid' } });

  // Page through two at a time until a short page; every notice comes once, in the order the site lists them.
  const walked = [];
  let after = null;
  for (let pages = 0; pages < 200; pages++) {
    const page = await readApi(`/notices?kind=announcement&limit=2${after ? `&after=${after}` : ''}`);
    expect(page.status).toBe(200);
    expect(page.body.notices.length).toBeLessThanOrEqual(2);
    walked.push(...page.body.notices);
    if (page.body.next === null) break;
    expect(page.body.next).toBe(page.body.notices.at(-1).id);
    after = page.body.next;
  }
  const ids = walked.map((n) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.slice(0, 3)).toEqual([...mine].reverse());

  // The same data as the website's own read: the board the site loads holds these rows, field for field.
  const site = (await publishedNotices()).filter((n) => n.kind === 'announcement');
  expect(walked.slice(0, site.length)).toEqual(site);

  // One notice by its id; a cursor that is not a published notice refuses instead of starting again from the top.
  expect(await readApi(`/notices/${mine[0]}`)).toEqual({ status: 200, body: walked.find((n) => n.id === mine[0]) });
  expect(await readApi('/notices?limit=2&after=99999999-9999-4999-8999-999999999999')).toEqual({
    status: 400,
    body: { code: 'notify.notices_cursor_unknown' },
  });

  // And a visitor on the website sees the newest of them, as the API returned it.
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  try {
    await visitor.goto('/notice');
    const entry = visitor.getByTestId(`notice-${mine[2]}`);
    await expect(entry).toContainText(walked[0].title);
    await expect(entry).toContainText(walked[0].body);
  } finally {
    await visitor.context().close();
  }
});

test(`${J} #2 the status read without a key: components and top-level status as on /status`, async ({ browser }) => {
  const api = await readApi('/status');
  expect(api.status).toBe(200);
  // The same answer the site reads (statusPage.read), apart from the moment it was read.
  const { asOf: _asOf, ...site } = await statusRead();
  const { asOf, ...read } = api.body;
  expect(Number.isNaN(Date.parse(asOf))).toBe(false);
  expect(read).toEqual(site);

  // And /status shows those components and that top level. The page is the stack's as other journeys left it, so
  // this compares with what is there and changes nothing.
  const visitor = await browser.newPage({ baseURL: ORIGIN });
  try {
    await visitor.goto('/status');
    const main = visitor.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Platform status' })).toBeVisible();
    if (read.components.length === 0) {
      await expect(main.getByTestId('status-components-none')).toBeVisible();
      await expect(main.getByTestId('status-overall')).toHaveCount(0);
    } else {
      await expect(main.getByTestId('status-overall')).toHaveAttribute('data-state', read.overall);
      for (const component of read.components) {
        const row = main.getByTestId(`status-component-${component.id}`);
        await expect(row).toContainText(component.name);
        await expect(row).toHaveAttribute('data-state', component.state);
      }
    }
  } finally {
    await visitor.context().close();
  }
});
