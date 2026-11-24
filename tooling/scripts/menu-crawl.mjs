// The links a trader can follow from the app's front doors, for the hosted beta's reach check (tooling/ci/menu-reach.mjs;
// owner decision 24 Nov 2026: a step counts as proven only when it passes on the build the beta serves, reached through
// its menus). apps/customer/tests/real-app/menu-reach.pw.mjs runs it in the running app, signed out from the front page
// and signed in from Home: it opens each page it reaches, opens the top bar's door menus and the account menu, and
// records every visible link (`a[href]`) the page shows as an edge from the page to the link's path, and where each page
// it opened landed (`opened`: [path, landed]): a link counts only to a room the crawl opened and saw as itself, not one
// that sent it elsewhere (a sign-in guard). It follows links only, never a button, so it changes nothing; a room it
// opens once (its first address) stands for every address of that room.
export const MENU_REACH = 'menu reach';

/** Paths a link may name that are no page to open: a file, the API, or a step that signs the crawler out. */
const NOT_A_PAGE = /^\/(?:api|trpc|assets|static)\/|\.(?:pdf|csv|json|png|jpe?g|svg|zip|txt|xml)$|(?:^|\/)(?:logout|sign-?out)(?:\/|$)/i;

/** The path of a link's `href` on `origin`, or null when it leaves the app or is no page. */
export function linkPath(href, origin) {
  if (!href || /^(?:mailto|tel|javascript|data|blob):/i.test(href)) return null;
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return NOT_A_PAGE.test(path) ? null : path;
}

/**
 * Breadth first from `roots`, at most `limit` pages. `open(path)` shows the page and resolves to the path it landed on
 * (a guard or an alias may move it); `links()` gives the hrefs the page holds, its menus opened. `roomOf(path)` names the
 * room a path opens (null: no room). A room is opened once. Returns { edges: [[from, to]], opened: [[path, landed]],
 * errors, partial, left }.
 */
export async function crawlFrom(roots, { open, links, roomOf, origin, limit = 500, deadline = Infinity, now = Date.now }) {
  const edges = [];
  const errors = [];
  const opened = [];
  const rooms = new Set();
  const queue = [];
  const enqueue = (path) => {
    const room = roomOf(path);
    if (room === null || rooms.has(room)) return;
    rooms.add(room);
    queue.push(path);
  };
  for (const root of roots) enqueue(root);
  let partial = false;
  while (queue.length) {
    if (opened.length >= limit || now() > deadline) {
      partial = true;
      break;
    }
    const path = queue.shift();
    let at;
    try {
      at = await open(path);
    } catch (e) {
      errors.push({
        path,
        error: String(e?.message ?? e)
          .split('\n')[0]
          .slice(0, 200),
      });
      continue;
    }
    opened.push([path, at]);
    if (at !== path) {
      edges.push([path, at]);
      enqueue(at);
    }
    let hrefs = [];
    try {
      hrefs = await links();
    } catch (e) {
      errors.push({
        path: at,
        error: String(e?.message ?? e)
          .split('\n')[0]
          .slice(0, 200),
      });
    }
    for (const href of new Set(hrefs)) {
      const to = linkPath(href, origin);
      if (to === null || to === at) continue;
      edges.push([at, to]);
      enqueue(to);
    }
  }
  return { edges: dedupe(edges), opened, errors, partial, left: queue.length };
}

const dedupe = (edges) => [...new Map(edges.map((e) => [e.join('\n'), e])).values()];

/**
 * The hrefs a Playwright `page` holds. With `menus`, first its top bar's door menus and the account menu are opened (each
 * renders its rows only while open; apps/customer/src/app/TopBar.tsx): the bar is the same on every page, so a crawl
 * opens them on its first page only.
 */
export async function pageLinks(page, { menus = false } = {}) {
  // Shown links only: one a trader can see at this size (checkVisibility), not a phone-only or collapsed copy.
  const read = () => page.$$eval('a[href]', (as) => as.filter((a) => a.checkVisibility()).map((a) => a.getAttribute('href')));
  const hrefs = new Set(await read());
  if (!menus) return [...hrefs].filter(Boolean);
  const add = async () => {
    for (const h of await read()) hrefs.add(h);
  };
  for (const item of await page.locator('[data-testid="tb-item"]').all()) {
    try {
      await item.hover({ timeout: 2_000 });
      // A menu's rows can load after its box (Pay's grouped menu): wait for a row's link.
      await page.locator('[data-testid="tb-menu"] a[href]').first().waitFor({ state: 'visible', timeout: 2_000 });
      await add();
    } catch {
      /* a door with no menu */
    }
  }
  const account = page.getByRole('button', { name: 'Account menu', exact: true }).first();
  try {
    if (await account.isVisible()) {
      await account.click({ timeout: 2_000 });
      await add();
      await page.keyboard.press('Escape');
    }
  } catch {
    /* no account menu here */
  }
  return [...hrefs].filter(Boolean);
}

/**
 * Waits until the page's links stop changing: the count of `a[href]` held for half a second, at most `timeout`. A move
 * by the history API leaves the load state as it was, so the load events can't say when a room's links have rendered.
 */
export async function settled(page, timeout = 3_000) {
  await page
    .waitForFunction(
      () => {
        const n = document.querySelectorAll('a[href]').length;
        const now = performance.now();
        const w = (window.__menuCrawlSettle ??= { n: -1, since: now });
        if (n !== w.n) {
          w.n = n;
          w.since = now;
          return false;
        }
        return now - w.since >= 500;
      },
      null,
      { polling: 100, timeout },
    )
    .catch(() => {});
  await page.evaluate(() => delete window.__menuCrawlSettle).catch(() => {});
}
