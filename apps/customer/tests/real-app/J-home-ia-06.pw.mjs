import { test, expect } from '@playwright/test';
import { signUp } from './desk.mjs';
import {
  NOTICE_DRAIN_MINUTES,
  deskNotice,
  draftNotice,
  openNotices,
  publicNoticeCode,
  publishNotice,
  publishedNotices,
} from './notices.mjs';
import { expectServiceOff } from './service-off.mjs';
import { api, ORIGIN, tool } from './stack.mjs';

// J-home-ia-06, in the running app (docs/roadmap/journeys.json): I see announcements and maintenance on Home. Tests titled
// "J-home-ia-06 #<n>" prove a whole step. The stack's two TEST founders draft and publish through the notice board's own
// four-eyes door; every notice closes a few minutes after it opens, so a run leaves the board empty for the next one.
const J = 'J-home-ia-06';
const RUN = Date.now().toString(36);
// This run's own notices end inside the wait the next run gives them.
const WINDOW_MINUTES = NOTICE_DRAIN_MINUTES - 1;

// Serial: each step builds on the board the one before left; the service-down case, which restarts svc-notify, is last. The BLOCKED steps are in J-home-ia-06-blocked.pw.mjs, so
// their red by name never skips a built step.
test.describe.configure({ mode: 'serial' });

let page;
let announcement;
let maintenance;
// A draft that stays a draft through the whole run, so "a draft never shows" is also checked beside live notices.
let kept;

/**
 * Home after both notice reads have answered, so "nothing drawn" is an answer and not a page still loading. Returns what
 * the two reads answered: { status, current }, each the tRPC reply's JSON.
 */
async function openHome() {
  const status = page.waitForResponse((res) => res.url().includes('/notify.noticeStatus'));
  const current = page.waitForResponse((res) => res.url().includes('/notify.announcement'));
  await page.goto('/home');
  const [statusRes, currentRes] = await Promise.all([status, current]);
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeAttached();
  return { status: await answer(statusRes), current: await answer(currentRes) };
}

/** A read's answer: ok, and its JSON, or null when the body is not JSON (a proxy's error page while a service is down). */
async function answer(res) {
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON: the caller's checks on ok and the code say what was wrong.
  }
  return { ok: res.ok(), json };
}

/** A tRPC refusal's typed code, at the one place svc-notify and svc-identity put it (as notices.mjs reads it). */
const refusalCode = (json) => json?.error?.data?.cause?.code;

/** The one row the founders' desk holds for this draft, read back from svc-notify, not from the draft reply. */
async function deskRow(row) {
  const rows = await deskNotice(row);
  expect(rows, `${row.id} on the notice desk`).toHaveLength(1);
  return rows[0];
}

/** No notice row of any kind on the page: no banner (incident or maintenance) and no strip. */
async function expectNoNoticeRows() {
  await expect(page.getByTestId('home-notices')).toHaveCount(0);
  await expect(page.getByTestId('home-notice')).toHaveCount(0);
  // An incident banner is an alert; a maintenance banner and the announcement strip are status rows (Notices.tsx).
  await expect(page.getByRole('alert', { name: 'Incident' })).toHaveCount(0);
  for (const name of ['Maintenance', 'Announcement']) await expect(page.getByRole('status', { name })).toHaveCount(0);
}

/** Both of Home's notice reads answered ok: a failed read also draws nothing, so "nothing" must be an answer. */
function expectAnswered({ status, current }) {
  expect(status.ok, JSON.stringify(status.json)).toBe(true);
  expect(current.ok || refusalCode(current.json) === 'notify.announcement_unset', JSON.stringify(current.json)).toBe(true);
}

/** svc-notify stopped for `run`, then started again whatever happened; a failed start never hides `run`'s own failure. */
async function withNotifyStopped(run) {
  tool('local-test-stack.mjs', 'stop', 'notify');
  let failure = null;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  try {
    tool('local-test-stack.mjs', 'start', '--only', 'notify');
  } catch (error) {
    // Both stay visible: the step's own failure, and a stack left with svc-notify down for the next journey.
    if (failure) throw new AggregateError([failure, error], `${failure.message}; and svc-notify did not start again: ${error.message}`);
    throw error;
  }
  if (failure) throw failure;
}

/** "23 Oct, 05:00", as Home words an end time in the browser's own zone (UTC here). */
const dayTime = (iso) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(Date.parse(iso));

test.beforeAll(async ({ browser }) => {
  test.setTimeout((NOTICE_DRAIN_MINUTES + 2) * 60_000);
  const context = await browser.newContext({ baseURL: ORIGIN, timezoneId: 'UTC', viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  await signUp(page, 'hmn');
  // An earlier run's notices close on their own; wait for the board to be empty rather than start on its leftovers.
  await expect
    .poll(
      async () => {
        const open = await openNotices();
        return open.incidents.length + open.maintenance.length + (open.announcement ? 1 : 0);
      },
      { timeout: NOTICE_DRAIN_MINUTES * 60_000, intervals: [5_000] },
    )
    .toBe(0);
});

test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 with nothing published, Home draws no strip and no banner`, async () => {
  const { status, current } = await openHome();
  // Both reads answered, and answered "nothing": the status read with no incident and no maintenance window, and the
  // announcement read with its one typed answer for none published. A refused read would also draw nothing.
  expect(status.ok, JSON.stringify(status.json)).toBe(true);
  expect(status.json.result.data).toMatchObject({ incidents: [], maintenance: [] });
  expect(refusalCode(current.json), JSON.stringify(current.json)).toBe('notify.announcement_unset');
  await expectNoNoticeRows();
});

test(`${J} #4 a founder's draft never reaches the customer`, async () => {
  test.setTimeout(3 * 60_000);
  announcement = await draftNotice({
    kind: 'announcement',
    title: `TEST announcement ${RUN}`,
    body: 'TEST: a journey announcement on the local stack.',
    minutes: WINDOW_MINUTES,
    key: `${J}:${RUN}:announcement`,
  });
  maintenance = await draftNotice({
    kind: 'maintenance',
    title: `TEST maintenance ${RUN}`,
    body: 'TEST: a journey maintenance window on the local stack.',
    minutes: WINDOW_MINUTES,
    key: `${J}:${RUN}:maintenance`,
  });
  kept = await draftNotice({
    kind: 'announcement',
    title: `TEST kept draft ${RUN}`,
    body: 'TEST: a journey draft that is never published.',
    minutes: WINDOW_MINUTES,
    key: `${J}:${RUN}:kept`,
  });
  // svc-notify holds all three, as drafts: read back from the founders' desk, not from the draft reply.
  for (const row of [announcement, maintenance, kept]) expect((await deskRow(row)).status).toBe('draft');
  await expectDraftsHidden([announcement, maintenance, kept]);
});

/** The public reads and the customer's pages leave each draft out: the open board, the published list, the notice page. */
async function expectDraftsHidden(drafts) {
  const open = await openNotices();
  const openIds = [...open.incidents, ...open.maintenance, ...(open.announcement ? [open.announcement] : [])].map((n) => n.id);
  const publishedIds = (await publishedNotices()).map((n) => n.id);
  for (const row of drafts) {
    expect(openIds).not.toContain(row.id);
    expect(publishedIds).not.toContain(row.id);
    expect(await publicNoticeCode(row.id)).toBe('notify.notice_not_found');
  }
  expectAnswered(await openHome());
  for (const row of drafts) await expect(page.getByText(row.title)).toHaveCount(0);
  const feed = page.waitForResponse((res) => res.url().includes('/notify.notices'));
  await page.goto('/notice');
  expect((await feed).ok()).toBe(true);
  for (const row of drafts) {
    await expect(page.getByTestId(`notice-${row.id}`)).toHaveCount(0);
    await expect(page.getByText(row.title)).toHaveCount(0);
  }
  for (const row of drafts) {
    await page.goto(`/notice/${row.id}`);
    await expect(page.getByRole('heading', { name: 'This notice is not published' })).toBeVisible();
    await expect(page.getByText(row.title)).toHaveCount(0);
  }
}

test(`${J} #2 a published announcement shows once, with its kind and a link to the notice`, async () => {
  test.setTimeout(3 * 60_000);
  expect((await publishNotice(announcement, `${J}:${RUN}:announcement`)).status).toBe('published');
  // The same public reads that leave drafts out do hold a published notice, so their "absent" in #4 can fail.
  expect((await publishedNotices()).map((n) => n.id)).toContain(announcement.id);
  expect(await publicNoticeCode(announcement.id)).toBeNull();
  expectAnswered(await openHome());
  const strip = page.getByRole('status', { name: 'Announcement' });
  await expect(strip).toHaveCount(1);
  await expect(strip).toContainText('Announcement');
  await expect(strip.getByText(`TEST announcement ${RUN}`, { exact: true })).toHaveCount(1);
  await expect(page.getByText(`TEST announcement ${RUN}`, { exact: true })).toHaveCount(1);
  await expect(strip.getByRole('link', { name: 'All notices' })).toHaveAttribute('href', '/notice');
  await strip.getByRole('link', { name: 'Read' }).click();
  await expect(page).toHaveURL(new RegExp(`/notice/${announcement.id}$`));
  await expect(page.getByText(`TEST announcement ${RUN}`).first()).toBeVisible();
});

test(`${J} #3 during an open maintenance window, a banner shows its title and end time`, async () => {
  test.setTimeout(3 * 60_000);
  const published = await publishNotice(maintenance, `${J}:${RUN}:maintenance`);
  expect(published.status).toBe('published');
  await openHome();
  const banner = page.getByRole('status', { name: 'Maintenance' });
  await expect(banner).toHaveCount(1);
  await expect(banner).toContainText(`TEST maintenance ${RUN}`);
  await expect(banner).toContainText(`Until ${dayTime(published.endsAt)}`);
  await expect(banner.getByRole('link', { name: 'Read' })).toHaveAttribute('href', `/notice/${maintenance.id}`);
  // The announcement strip is still there, once, under the banner.
  await expect(page.getByRole('status', { name: 'Announcement' })).toHaveCount(1);
});

test(`${J} #4 beside a live announcement and maintenance window, the kept draft still never reaches the customer`, async () => {
  test.setTimeout(3 * 60_000);
  expect((await deskRow(kept)).status).toBe('draft');
  await expectDraftsHidden([kept]);
  // Home still shows the two published notices on the same load, so the draft's absence sits beside live rows.
  expectAnswered(await openHome());
  await expect(page.getByRole('status', { name: 'Announcement' })).toHaveCount(1);
  await expect(page.getByRole('status', { name: 'Maintenance' })).toHaveCount(1);
  await expect(page.getByText(kept.title)).toHaveCount(0);
});

test(`${J} #5 an action the shell cannot run because an outside service is off says one shared sentence, the same in every room`, async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  await context.grantPermissions(['notifications']);
  const person = await context.newPage();
  const who = await signUp(person, 'hmo');
  // Notifications: allowing this device needs the push delivery gateway, which the stack leaves unset.
  await person.goto('/notifications?view=settings');
  const push = person.locator('[data-testid="nf-channelcard"][data-channel="push"]');
  await push.getByRole('button', { name: 'Allow notifications on this device' }).click();
  const pushed = await expectServiceOff(push.locator('[data-not-connected]'), 'vendor.push', 'Registering this device');
  // Web3: staking needs the INTACHAIN launch go-ahead. Same component, same sentence, its own code.
  await person.goto('/chain/validators');
  const stake = person.locator('[data-action="stake"]');
  await expect(stake.getByRole('button', { name: 'Stake' })).toBeDisabled();
  const staked = await expectServiceOff(stake.locator('[data-not-connected]'), 'chain.go', 'Stake');
  // Security: linking a social account is a live button; pressing it reaches identity, which answers that the outside
  // sign-in provider is off, and the card says the same sentence with that code.
  await person.goto('/uc/safe');
  const methods = person.getByTestId('security__signin-methods');
  const social = methods
    .getByRole('listitem', { name: 'Social account', exact: true })
    .getByRole('button', { name: 'Link a social account' });
  await expect(social).toBeEnabled();
  const started = person.waitForResponse((res) => res.url().includes('/linkProviderStart'));
  await social.click();
  const refused = await (await started).json();
  expect(refusalCode(refused), JSON.stringify(refused)).toBe('idp.social');
  const linked = await expectServiceOff(methods.locator('[data-not-connected]'), 'idp.social', 'Signing in with a social account');
  // The whole sentence, its dependency words included, is the shared copy's own, for each code.
  // The dependency words are written here, not read from the app's copy (src/shared/service-off.tsx), so a wrong
  // wording there turns this red.
  const sentence = (action, dependency, code) => `${action} needs ${dependency}. It is switched off in this build. ${code}`;
  expect(pushed).toBe(sentence('Registering this device', 'a push delivery gateway', 'vendor.push'));
  expect(staked).toBe(sentence('Stake', 'the INTACHAIN launch go-ahead', 'chain.go'));
  expect(linked).toBe(sentence('Signing in with a social account', 'an outside sign-in provider', 'idp.social'));
  // An own gap is not the notice: the bell draws exactly this person's inbox as svc-notify holds it, the empty state when it
  // holds nothing, and never data-not-connected. Other journeys on the same stack may publish notices to every inbox, so
  // the popover is compared with the inbox read back, not assumed empty.
  await person.goto('/home');
  await person.getByTestId('tb-bell').click();
  const pop = person.locator('.nf-pop__inner');
  const empty = pop.locator('[data-slot="state-block"][data-kind="empty"]', { hasText: "You're all caught up." });
  const rows = pop.getByTestId('nf-row');
  await expect(empty.or(rows.first())).toBeVisible();
  const client = await api(who);
  const inbox = async () =>
    (await client.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 8 }))}`)).body.result.data.items
      .length;
  // Each read holds the inbox's size, the rows drawn and whether the empty state shows; they must agree.
  await expect
    .poll(async () => {
      const [held, drawn, shown] = [await inbox(), await rows.count(), await empty.count()];
      return drawn === held && shown === (held === 0 ? 1 : 0) ? 'agree' : `inbox ${held}, rows ${drawn}, empty ${shown}`;
    })
    .toBe('agree');
  await expect(pop.locator('[data-not-connected]')).toHaveCount(0);
  await context.close();
});

// Last: it stops and starts svc-notify, so a red here skips no other step.
test(`${J} #1 with the notice service down, Home draws no strip and no banner, the rest of Home is unaffected, and one line per failed read is logged`, async () => {
  test.setTimeout(15 * 60_000);
  await withNotifyStopped(async () => {
    const warnings = [];
    const onConsole = (msg) => msg.type() === 'warning' && msg.text().startsWith('home notices:') && warnings.push(msg.text());
    page.on('console', onConsole);
    try {
      const { status, current } = await openHome();
      expect(status.ok).toBe(false);
      expect(current.ok).toBe(false);
      await expectNoNoticeRows();
      // The rest of Home still draws: its heading and its own sections, with no page-level error.
      await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
      await expect(page.getByRole('main')).not.toContainText('Something went wrong');
      // One line per failed read: Home re-reads, so a line may repeat; each read's line is there, and no other.
      await expect.poll(() => new Set(warnings).size).toBe(2);
      expect([...new Set(warnings)].sort()).toEqual([
        expect.stringMatching(/^home notices: announcement unread \(\S+\)$/),
        expect.stringMatching(/^home notices: notice status unread \(\S+\)$/),
      ]);
    } finally {
      page.off('console', onConsole);
    }
  });
});
