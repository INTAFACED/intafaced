// World: none
import { test } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { MENU_REACH, crawlFrom, pageLinks } from '../../../../tooling/scripts/menu-crawl.mjs';

// The links a trader can follow from the app's front doors (tooling/scripts/menu-crawl.mjs), for the hosted beta's reach
// check: tooling/ci/menu-reach.mjs reads this test's `menu reach` annotation beside each step's screens, and a step whose
// screen no link path reaches from these doors is not proven (owner decision 24 Nov 2026). Signed out from the front page
// and every room an emailed link opens (`publicFrame`), then signed in, verified, from Home. It records, never fails:
// a crawl that breaks says why in its record, and the check then counts no step from this run.
const PAGE_MS = 15_000;
const CRAWL_MS = 7 * 60_000;

test('menu reach: the links from the front page and Home', async ({ page }) => {
  test.setTimeout(2 * CRAWL_MS + 4 * 60_000);
  const record = { version: 1 };
  try {
    const { rooms, findRoom } = await import('../../src/app/navigation.ts');
    const origin = new URL(test.info().project.use.baseURL).origin;
    const roomOf = (path) => findRoom(path)?.path ?? null;
    const open = async (path) => {
      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
      return new URL(page.url()).pathname.replace(/\/+$/, '') || '/';
    };
    const crawl = (roots) => crawlFrom(roots, { open, links: () => pageLinks(page), roomOf, origin, deadline: Date.now() + CRAWL_MS });
    const emailed = rooms.filter((room) => room.publicFrame && !/[:*]/.test(room.path)).map((room) => room.path);
    const signedOutRoots = ['/', ...emailed.filter((path) => path !== '/')];
    record.signedOut = { roots: signedOutRoots, ...(await crawl(signedOutRoots)) };
    const who = await signUp(page, 'mrc');
    await verify(page, who);
    await signIn(page, who);
    record.signedIn = { roots: ['/home'], ...(await crawl(['/home'])) };
  } catch (e) {
    record.unread = String(e?.message ?? e)
      .split('\n')[0]
      .slice(0, 300);
  } finally {
    test.info().annotations.push({ type: MENU_REACH, description: JSON.stringify(record) });
  }
});
