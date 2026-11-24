// World: none
import { test } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { MENU_REACH, crawlFrom, pageLinks, settled } from '../../../../tooling/scripts/menu-crawl.mjs';

// The links a trader can follow from the app's front doors (tooling/scripts/menu-crawl.mjs), for the hosted beta's reach
// check: tooling/ci/menu-reach.mjs reads this test's `menu reach` annotation beside each step's screens, and a step whose
// screen no link path reaches from these doors is not proven (owner decision 24 Nov 2026). Signed out from the front page
// and every room an emailed link opens (`publicFrame`), then signed in, verified, from Home (and the team desk's own doors). It records, never fails:
// a crawl that breaks says why in its record, and the check then counts no step from this run.
const PAGE_MS = 15_000;
const CRAWL_MS = 8 * 60_000;

test('menu reach: the links from the front page and Home', async ({ page }) => {
  test.setTimeout(2 * CRAWL_MS + 4 * 60_000);
  const record = { version: 1 };
  try {
    const { rooms, findRoom } = await import('../../src/app/navigation.ts');
    const origin = new URL(test.info().project.use.baseURL).origin;
    const roomOf = (path) => findRoom(path)?.path ?? null;
    // After its first page, a crawl moves the way the app's own links do (location.ts navigate: a history entry, then
    // popstate), not by reloading the app each time: a reload took about 4 s a page. The crawl reads links, never acts.
    let loaded = false;
    const open = async (path) => {
      if (loaded) {
        await page.evaluate((to) => {
          history.pushState(null, '', to);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, path);
      } else await page.goto(path, { waitUntil: 'domcontentloaded', timeout: PAGE_MS });
      loaded = true;
      await settled(page);
      return new URL(page.url()).pathname.replace(/\/+$/, '') || '/';
    };
    // The top bar is on every page, so its menus are opened on a crawl's first page only.
    const crawl = (roots) => {
      let first = true;
      loaded = false;
      const links = () => {
        const menus = first;
        first = false;
        return pageLinks(page, { menus });
      };
      return crawlFrom(roots, { open, links, roomOf, origin, deadline: Date.now() + CRAWL_MS });
    };
    const emailed = rooms.filter((room) => room.publicFrame && !/[:*]/.test(room.path)).map((room) => room.path);
    const signedOutRoots = ['/', ...emailed.filter((path) => path !== '/')];
    record.signedOut = { roots: signedOutRoots, ...(await crawl(signedOutRoots)) };
    const who = await signUp(page, 'mrc');
    await verify(page, who);
    await signIn(page, who);
    // The team desk is its own console at its own address (rooms/team.ts): an operator's front door, as Home is a trader's.
    const desks = rooms.filter((room) => room.area === 'team' && !/[:*]/.test(room.path)).map((room) => room.path);
    record.signedIn = { roots: ['/home', ...desks], ...(await crawl(['/home', ...desks])) };
  } catch (e) {
    record.unread = String(e?.message ?? e)
      .split('\n')[0]
      .slice(0, 300);
  } finally {
    test.info().annotations.push({ type: MENU_REACH, description: JSON.stringify(record) });
  }
});
