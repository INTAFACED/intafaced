// World: none
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';
import { createEvent, moveEvent, onboardedIssuer } from './launch.mjs';

// J-more-catalogue-01, in the running app (docs/roadmap/journeys.json): find my way around the six More rooms. One test
// per step, titled "J-more-catalogue-01 #<n>", run in order. Step 1 signs up a fresh TEST account; the later steps sign it
// in again from the run file. No money moves in this journey; it proves the room-set's addresses and labels.
const J = 'J-more-catalogue-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** The six rooms: the tile on /more, the room's start address and the page title it mounts with. */
const ROOMS = [
  { tile: 'predict', path: '/predict', title: 'Prediction' },
  { tile: 'market', path: '/market', title: 'Market' },
  { tile: 'launch', path: '/launch', title: 'Launch' },
  { tile: 'token', path: '/token/governance', title: 'Token governance', tileHref: '/token' },
  { tile: 'mining', path: '/mining', title: 'Mining' },
  { tile: 'blueprint', path: '/blueprint', title: 'Identity Blueprint' },
];

/** Every section address of the set whose last segment is reserved, and the title its own page carries. */
const SECTIONS = [
  ['/predict/positions', 'Predict positions'],
  ['/predict/settings', 'Predict settings'],
  ['/market/purchases', 'Market purchases'],
  ['/market/mine', 'My listings'],
  ['/market/strategy', 'Strategy subscriptions'],
  ['/launch/new', 'New launch'],
  ['/launch/check', 'Launch check'],
  ['/launch/requirements', 'Launch requirements'],
  ['/launch/mine', 'My Launch orders'],
  ['/token/governance', 'Token governance'],
  ['/token/economy', 'Token economy'],
  ['/token/burn', 'Token burn'],
  ['/mining/workers', 'Mining workers'],
  ['/mining/shares', 'Mining shares'],
  ['/mining/rewards', 'Mining rewards'],
  ['/mining/status', 'Mining status'],
  ['/blueprint/crew', 'Blueprint crew'],
];

/**
 * The reserved addresses that are no page of their own: /blueprint/shared is only the start of a shared card's address
 * (/blueprint/shared/<card>), and under /token/governance/<proposal> a token section's name is no proposal. Each answers
 * with the room-set's "no customer route" panel, never a record.
 */
const NOT_A_PAGE = ['/blueprint/shared', '/token/governance/economy', '/token/governance/burn'];

/**
 * Every reserved first segment under each room (the app's own list, `RESERVED_SEGMENTS` in
 * apps/customer/src/features/more/more-room-routes.ts), and the title of that room's record page, which a reserved
 * segment must never open.
 */
const RESERVED = {
  predict: { segments: ['positions', 'settings'], record: 'Prediction market' },
  market: { segments: ['mine', 'strategy', 'purchases'], record: 'Market listing' },
  launch: { segments: ['new', 'check', 'requirements', 'mine'], record: 'Launch project' },
  token: { segments: ['governance', 'economy', 'burn'], record: 'Governance proposal' },
  mining: { segments: ['workers', 'shares', 'rewards', 'status'], record: 'Mining worker' },
  blueprint: { segments: ['shared', 'crew'], record: 'Shared card' },
};

/**
 * A write to the stack: any request to /api/ other than a read (GET, HEAD, OPTIONS), tRPC or REST. The session's own
 * token refresh (identity `auth.refresh`) is left out: the app sends it by itself on a timer, no control sends it, and it
 * changes no record.
 */
const isWrite = (request) => {
  const { pathname } = new URL(request.url());
  return (
    pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname !== '/api/identity/trpc/auth.refresh'
  );
};

function who() {
  const s = run.read();
  if (!s.who) throw new Error(`${J}: step 1 left no account, so this step has no one to sign in`);
  return s.who;
}

const heading = (page) => page.locator('main h1').first();

test(`${J} #1 /more lists the six rooms, none hidden, each opening its own room`, async ({ page }) => {
  run.reset({ who: await signUp(page, 'jmc1') });
  await page.goto('/more');
  for (const room of ROOMS) {
    const tile = page.locator(`a[data-tile="${room.tile}"]`);
    await expect(tile, room.tile).toBeVisible();
    await expect(tile, room.tile).toHaveAttribute('href', room.tileHref ?? room.path);
  }
  // Every section is a region named by its own heading: its id is made from its key, so aria-labelledby finds it.
  for (const name of ['Learn and build', 'Markets and assets', 'Money and pay', 'Rewards', 'Web3', 'Help', 'Account', 'All services']) {
    await expect(page.getByRole('region', { name, exact: true }).filter({ has: page.getByTestId('more-h2') }), name).toBeVisible();
  }
  const labels = await page
    .locator('section[aria-labelledby]')
    .evaluateAll((nodes) =>
      nodes.map((n) => [n.getAttribute('aria-labelledby'), Boolean(document.getElementById(n.getAttribute('aria-labelledby')))]),
    );
  for (const [id, found] of labels) {
    expect(id, 'a section id has no spaces').toMatch(/^\S+$/);
    expect(found, `${id} names an element on the page`).toBe(true);
  }
  // No registry status but hidden drops a tile (none is hidden today): all 23 are drawn, Help and Notifications among them.
  await expect(page.locator('a[data-tile]')).toHaveCount(23);
  for (const tile of ['help', 'notifications']) await expect(page.locator(`a[data-tile="${tile}"]`), tile).toBeVisible();
});

test(`${J} #2 each room's start address mounts that room under its own title`, async ({ page }) => {
  await signIn(page, who());
  for (const room of ROOMS) {
    await page.goto(room.path);
    await expect(heading(page), room.path).toHaveText(room.title);
    await expect(page.getByText('This destination has no customer route'), room.path).toHaveCount(0);
  }
});

test(`${J} #3 /predict/positions is the positions room, and every reserved section opens its own page, never a record`, async ({
  page,
}) => {
  await signIn(page, who());
  for (const [path, title] of SECTIONS) {
    await page.goto(path);
    await expect(heading(page), path).toHaveText(title);
    await expect(page.getByText('No details are shown for this record'), path).toHaveCount(0);
    await expect(page.getByText('That address is not valid'), path).toHaveCount(0);
  }
  // The same holds for every reserved segment of every room: it is never taken for a record id, so it never opens the
  // room's record page (titled as a record, or refusing the segment as a bad record id). /token's reserved segments are
  // checked under /token/governance/<segment> too, its record route.
  for (const [room, { segments, record }] of Object.entries(RESERVED)) {
    const base = room === 'token' ? ['/token', '/token/governance'] : [`/${room}`];
    for (const prefix of base)
      for (const segment of segments) {
        if (prefix === '/token/governance' && segment === 'governance') continue;
        const path = `${prefix}/${segment}`;
        const own = SECTIONS.find(([p]) => p === path)?.[1];
        expect(own !== undefined || NOT_A_PAGE.includes(path), `${path} is a section with its own title, or named as no page`).toBe(true);
        await page.goto(path);
        if (own) {
          // A section: the page it opens is that section, under its own title.
          await expect(heading(page), path).toHaveText(own);
          await expect(page.getByText('This destination has no customer route'), path).toHaveCount(0);
        } else {
          // No page of its own: the "no customer route" panel under the More title, with its link to /more.
          await expect(heading(page), path).toHaveText('More');
          await expect(page.getByText('This destination has no customer route'), path).toBeVisible();
          await expect(page.getByRole('link', { name: 'Open More' }), path).toHaveAttribute('href', '/more');
        }
        await expect(heading(page), `${path} is not a ${record}`).not.toHaveText(record);
        await expect(page.getByText('That address is not valid'), path).toHaveCount(0);
        await expect(page.getByText('No details are shown for this record'), path).toHaveCount(0);
      }
  }
});

test(`${J} #4 an unknown address under a room shows the "no customer route" panel with a link to /more`, async ({ page }) => {
  await signIn(page, who());
  for (const path of ['/market/a/b/c', '/mining/workers/w-1/extra', '/blueprint/elsewhere']) {
    await page.goto(path);
    await expect(page.getByText('This destination has no customer route'), path).toBeVisible();
    await page.getByRole('link', { name: 'Open More' }).click();
    await expect(page).toHaveURL('/more');
  }
});

test(`${J} #5 ?simulated=true labels every room simulated, and an action there is refused before anything is sent`, async ({ page }) => {
  await signIn(page, who());
  for (const room of ROOMS) {
    await page.goto(`${room.path}?simulated=true`);
    const banner = page.locator('[data-paper="simulated"]');
    await expect(banner, room.path).toBeVisible();
    await expect(banner, room.path).toContainText('Simulated view');
    await expect(banner.getByRole('link', { name: 'Open the live room' }), room.path).toHaveAttribute('href', room.path);
  }

  // No mutation control is attached in the simulated view: in each room, every control on the page is pressed, and not
  // one write leaves the browser.
  const writes = [];
  page.on('request', (request) => {
    if (isWrite(request)) writes.push(request.url());
  });
  for (const room of ROOMS) {
    const at = `${room.path}?simulated=true`;
    await page.goto(at);
    await expect(page.locator('[data-paper="simulated"]'), room.path).toBeVisible();
    const controls = page.locator('main button:not([disabled])');
    const count = await controls.count();
    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click({ timeout: 5_000 });
      await page.keyboard.press('Escape');
      if (new URL(page.url()).pathname !== room.path) await page.goto(at);
    }
    expect(writes, `${room.path}: no write sent in the simulated view`).toEqual([]);
  }

  // Erasing the Blueprint is a write every fresh account can reach: in the simulated view the control answers with the
  // refusal, no review opens and no request leaves the browser.
  await page.goto('/blueprint?simulated=true');
  await page.getByLabel('Type ERASE BLUEPRINT').fill('ERASE BLUEPRINT');
  await page.getByRole('button', { name: 'Review permanent erasure' }).click();
  await expect(page.getByText('This is a simulated view, so the action was not sent. Open the live room to act.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.goto('/blueprint');
  await expect(page.locator('[data-paper]')).toHaveCount(0);
});

/** The one sign-in panel the More rooms use: its title, and a Sign in link back to `returnTo`. */
async function expectSignInPanel(scope, returnTo, label) {
  await expect(scope.getByText('Sign in to continue', { exact: true }), label).toBeVisible();
  await expect(scope.getByRole('link', { name: 'Sign in', exact: true }).first(), label).toHaveAttribute(
    'href',
    `/login?redirect=${encodeURIComponent(returnTo)}`,
  );
}

test(`${J} #6 signed out, every room shows the sign-in panel the other More rooms use; /launch is the public catalogue with it on its gated parts`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  for (const room of ROOMS.filter((r) => r.tile !== 'launch')) {
    await page.goto(room.path);
    await expectSignInPanel(page.locator('main'), room.path, room.path);
  }

  // /launch signed out: the public catalogue, with an open TEST launch listed, and the panel on its sign-in-gated
  // parts: a launch's eligibility, and subscribing (the participation section).
  const tag = Date.now().toString(36);
  const issuer = await onboardedIssuer(`tst-issuer-mc01-${tag}`, `TEST Issuer ${tag}`);
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const open = {
    id: `tst-mc01-${tag}`,
    issuerId: issuer.id,
    type: 'token_sale',
    projectName: `TEST More Launch ${tag}`,
    symbol: 'TSTM',
    periods: {
      announceAt: at(now - 60_000),
      snapshotAt: at(now - 60_000),
      openAt: at(now - 60_000),
      closeAt: at(now + 30 * 86_400_000),
      distributionAt: at(now + 31 * 86_400_000),
    },
    allocation: { method: 'pro_rata', perUserCap: '250', ticketSize: null, tierWeights: null },
    terms: { price: '0.5', paymentAsset: 'USDT', rateSource: null },
  };
  let revision = await createEvent(open);
  for (const to of ['announced', 'snapshot', 'open']) revision = (await moveEvent(open.id, to, revision)).revision;

  await page.goto('/launch');
  await expect(heading(page)).toHaveText('Launch');
  const card = page.getByRole('list', { name: 'Launch events' }).getByRole('listitem').filter({ hasText: open.projectName });
  await expect(card).toHaveCount(1);
  await page.goto(`/launch/${open.id}`);
  await expectSignInPanel(page.getByRole('region', { name: 'Who may take part' }), `/launch/${open.id}`, 'eligibility');
  await page.goto('/uc/innovation/myorders');
  await expectSignInPanel(page.locator('main'), '/uc/innovation/myorders', 'subscribe (participation)');
});
