import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

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
  ['/market/purchases', 'Market purchases'],
  ['/market/mine', 'My listings'],
  ['/market/strategy', 'Strategy subscriptions'],
  ['/launch/new', 'New launch'],
  ['/launch/check', 'Launch check'],
  ['/launch/requirements', 'Launch requirements'],
  ['/token/governance', 'Token governance'],
  ['/token/economy', 'Token economy'],
  ['/token/burn', 'Token burn'],
  ['/mining/workers', 'Mining workers'],
  ['/mining/shares', 'Mining shares'],
  ['/mining/rewards', 'Mining rewards'],
  ['/mining/status', 'Mining status'],
  ['/blueprint/crew', 'Blueprint crew'],
];

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

  // Erasing the Blueprint is a write every fresh account can reach: in the simulated view the control answers with the
  // refusal, no review opens and no request leaves the browser.
  const writes = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/trpc\/blueprint\./.test(request.url())) writes.push(request.url());
  });
  await page.goto('/blueprint?simulated=true');
  await page.getByLabel('Type ERASE BLUEPRINT').fill('ERASE BLUEPRINT');
  await page.getByRole('button', { name: 'Review permanent erasure' }).click();
  await expect(page.getByText('This is a simulated view, so the action was not sent. Open the live room to act.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.goto('/blueprint');
  await expect(page.locator('[data-paper]')).toHaveCount(0);
});

test(`${J} #6 signed out, every room shows the sign-in panel the other More rooms use`, async ({ page }) => {
  for (const room of ROOMS) {
    await page.goto(room.path);
    await expect(page.getByText('Sign in to continue'), room.path).toBeVisible();
  }
});
