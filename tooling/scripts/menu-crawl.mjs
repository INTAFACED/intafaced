// The links a trader can follow from the app's front doors, for the hosted beta's reach check (tooling/ci/menu-reach.mjs;
// owner decision 24 Nov 2026: a step counts as proven only when it passes on the build the beta serves, reached through
// its menus). apps/customer/tests/real-app/menu-reach.pw.mjs runs it in the running app, signed out from the front page
// and signed in from Home: it opens each page it reaches, opens the top bar's door menus and the account menu, and
// records every link (`a[href]`) the page holds as an edge from the page to the link's path. It follows links only, never
// a button, so it changes nothing; a room it opens once (its first address) stands for every address of that room.
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
 * room a path opens (null: no room). A room is opened once. Returns { edges: [[from, to]], opened, errors, partial }.
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
    opened.push(path);
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
  return { edges: dedupe(edges), opened, errors, partial };
}

const dedupe = (edges) => [...new Map(edges.map((e) => [e.join('\n'), e])).values()];

/**
 * The hrefs a Playwright `page` holds. With `menus`, first its top bar's door menus and the account menu are opened (each
 * renders its rows only while open; apps/customer/src/app/TopBar.tsx): the bar is the same on every page, so a crawl
 * opens them on its first page only.
 */
export async function pageLinks(page, { menus = false } = {}) {
  const read = () => page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
  const hrefs = new Set(await read());
  if (!menus) return [...hrefs].filter(Boolean);
  const add = async () => {
    for (const h of await read()) hrefs.add(h);
  };
  for (const item of await page.locator('[data-testid="tb-item"]').all()) {
    try {
      await item.hover({ timeout: 2_000 });
      await page.locator('[data-testid="tb-menu"]').first().waitFor({ state: 'visible', timeout: 1_000 });
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
