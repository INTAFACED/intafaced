import { isDeepStrictEqual } from 'node:util';
import { test, expect } from '@playwright/test';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { draftNotice, publishNotice, publishedNotices } from './notices.mjs';
import { statusRead } from './status-page.mjs';
import { EDGE, ORIGIN, api } from './stack.mjs';

// J-support-public-09, in the running app (docs/roadmap/journeys.json): a developer reads status and notices through the
// documented API and sends a comment from code. Tests titled "J-support-public-09 #<n>" prove a whole step. The API is
// called the way a developer's code calls it: plain HTTP to Edge, with no session and no cookie, and from #3 on with a
// personal API key the developer made in the app (support:read and support:write; only an account with a verified passkey
// may hold a key, so the person adds one first). The stack's TEST owner value caps a requester's comments at 50 per request
// (SUPPORT_COMMENT_CAP); with it blank every requester comment refuses support.comment_cap_unset, which svc-support's
// comment-key tests prove, since the running stack cannot change that value mid-run.
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
  // The same answer the site reads (statusPage.read), apart from the moment it was read. The API may answer from a read
  // up to a few seconds old (unsigned callers poll it), so a change made just before by another journey can lag once.
  let read;
  await statusRead(); // signs the stack's founders in once, so the comparison below is two reads moments apart
  await expect
    .poll(
      async () => {
        const api = await readApi('/status');
        expect(api.status).toBe(200);
        const { asOf, ...rest } = api.body;
        expect(Number.isNaN(Date.parse(asOf))).toBe(false);
        read = rest;
        const { asOf: _siteAsOf, ...site } = await statusRead();
        return isDeepStrictEqual(rest, site);
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);

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

const COMMENT_CAP = 50;

/** One call of the support API with the developer's key, as code sends it: a bearer key, no cookie, no origin. */
async function withKey(key, method, procedure, input) {
  const query = method === 'GET' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
  const res = await fetch(`${EDGE}/api/support/trpc/${procedure}${query}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? JSON.stringify(input) : undefined,
  });
  const body = await res.json();
  return { status: res.status, data: body?.result?.data, code: /\bsupport(?:\.[a-z0-9_]+)+/.exec(body?.error?.message ?? '')?.[0], body };
}

/** @type {{ key: string, mine: string, theirs: string, who: object }} */
let dev;

test.describe('with a key', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    // Somebody else with a request of their own, which the key must never show.
    const otherPage = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
    const other = await signUp(otherPage, 'sp9o');
    await otherPage.context().close();
    const theirs = await (
      await api(other)
    ).post('/api/support/trpc/create', {
      category: 'account',
      subject: `TEST journey ${J} ${RUN} someone else`,
      body: "TEST a request that is not the developer's.",
    });
    expect(theirs.status).toBe(200);

    // The developer: an account with a passkey, a request of their own, and a key made in the developer room.
    const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
    await virtualAuthenticator(page);
    const who = await signUp(page, 'sp9d');
    await verify(page, who);
    await signIn(page, who);
    await addPasskey(page);
    const mine = await (
      await api(who)
    ).post('/api/support/trpc/create', {
      category: 'account',
      subject: `TEST journey ${J} ${RUN} from code`,
      body: 'TEST a request the developer reads and comments on through the API.',
    });
    expect(mine.status).toBe(200);

    await page.goto('/uc/safe/api-keys/new');
    await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
    await page.getByLabel('Key name').fill('support-bot');
    await page.getByLabel('Read only', { exact: true }).check();
    await page.locator('input[name=scope][value="support:write"]').check();
    await expect(page.locator('input[name=scope][value="support:read"]')).toBeChecked();
    await expect(page.locator('input[name=scope][value="support:ops"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
    const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
    expect(key).toMatch(/^ifc_[A-Za-z0-9_-]{20,}$/);
    await page.context().close();
    dev = { key, mine: mine.body.result.data.id, theirs: theirs.body.result.data.id, who };
  });

  test(`${J} #3 lists requests with the key: only the key owner's`, async () => {
    const listed = await withKey(dev.key, 'GET', 'listMine', { limit: 50 });
    expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
    const ids = listed.data.map((t) => t.id);
    expect(ids).toEqual([dev.mine]);
    expect(ids).not.toContain(dev.theirs);
    // The other person's request by its id reads the same as one that does not exist.
    const theirs = await withKey(dev.key, 'GET', 'get', { ticketId: dev.theirs });
    expect(theirs.status).toBe(404);
    expect(theirs.data).toBeUndefined();
    expect(JSON.stringify(theirs.body)).not.toContain('someone else');
  });

  test(`${J} #4 posts a comment twice with the same client request id: one comment`, async () => {
    const comment = { ticketId: dev.mine, body: `TEST comment from code ${RUN}`, clientRequestId: `${J}:${RUN}:comment-1` };
    const first = await withKey(dev.key, 'POST', 'comment', comment);
    expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
    // The same call again, as a retry after a lost answer sends it: the first comment back, nothing new stored.
    const again = await withKey(dev.key, 'POST', 'comment', comment);
    expect(again.status).toBe(200);
    expect(again.data).toEqual(first.data);
    const thread = await withKey(dev.key, 'GET', 'listComments', { ticketId: dev.mine, limit: 100 });
    expect(thread.data.filter((c) => c.body === comment.body)).toHaveLength(1);
    // Other words under the same id refuse, and still nothing new is stored.
    const changed = await withKey(dev.key, 'POST', 'comment', { ...comment, body: 'TEST other words' });
    expect([changed.status, changed.code]).toEqual([409, 'support.idempotency_conflict']);
    expect((await withKey(dev.key, 'GET', 'listComments', { ticketId: dev.mine, limit: 100 })).data).toHaveLength(thread.data.length);
  });

  test(`${J} #5 a comment on a request at the owner's comment cap: support.comment_cap_reached`, async () => {
    test.setTimeout(120_000);
    const before = (await withKey(dev.key, 'GET', 'listComments', { ticketId: dev.mine, limit: 100 })).data;
    const mineSoFar = before.filter((c) => c.authorRole === 'user').length;
    // Fill the request to the cap, a few a second (Edge limits a burst from one address).
    for (let n = mineSoFar; n < COMMENT_CAP; n++) {
      const sent = await withKey(dev.key, 'POST', 'comment', {
        ticketId: dev.mine,
        body: `TEST filler ${n}`,
        clientRequestId: `${J}:${RUN}:fill-${n}`,
      });
      expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const over = await withKey(dev.key, 'POST', 'comment', {
      ticketId: dev.mine,
      body: 'TEST one too many',
      clientRequestId: `${J}:${RUN}:over`,
    });
    expect([over.status, over.code]).toEqual([412, 'support.comment_cap_reached']);
    const after = (await withKey(dev.key, 'GET', 'listComments', { ticketId: dev.mine, limit: 100 })).data;
    expect(after.filter((c) => c.authorRole === 'user')).toHaveLength(COMMENT_CAP);
    expect(after.some((c) => c.body === 'TEST one too many')).toBe(false);
  });

  test(`${J} #6 tries a staff procedure with the key: refused, a key never carries support:ops`, async () => {
    for (const [method, procedure, input] of [
      ['GET', 'listAll', { limit: 10 }],
      ['GET', 'listQueue', { limit: 10 }],
      ['POST', 'setStatus', { ticketId: dev.mine, status: 'resolved' }],
    ]) {
      const refused = await withKey(dev.key, method, procedure, input);
      expect(refused.status, `${procedure} ${JSON.stringify(refused.body).slice(0, 300)}`).toBe(403);
    }
    // And no key can be made with it: identity refuses the scope outright.
    const asked = await (
      await api(dev.who)
    ).post('/api/identity/trpc/developerKeys.create', {
      name: 'support-desk-bot',
      scopes: ['support:ops'],
      requestId: `${J}:${RUN}:ops-key`,
    });
    // A refusal of the ask, never a server failure that happens to name the scope.
    expect(asked.status).toBeGreaterThanOrEqual(400);
    expect(asked.status).toBeLessThan(500);
    expect(JSON.stringify(asked.body)).toMatch(/auth\.scope_(interactive_only|not_held)/);
  });
});
