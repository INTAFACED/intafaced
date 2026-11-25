// The in-app moves each journey test made, for the hosted beta's reach check (tooling/ci/menu-reach.mjs, owner decision
// 24 Nov 2026: a step counts as proven only when its screens are reached through the beta's menus). The crawl
// (apps/customer/tests/real-app/menu-reach.pw.mjs) follows the links of a fresh, empty account, so a room that shows only a
// record the trader made (`/agents/<id>`, `/support/tickets/<id>`) has no link it can follow. A journey test that makes the
// record and then clicks through to it shows the way a trader takes: this records each such move, a pair [from, to] of two
// customer-app paths one main-frame navigation apart, as the test's `beta moves` annotation.
// A move is only what the app did on its own: a navigation inside `page.goto`, `reload`, `goBack` or `goForward` is a
// typed entry and makes none (it only sets where the next move starts); a page entered by a typed address with a query or
// a fragment makes none until its next plain typed entry, since the state that address set is no state a menu gave; a page
// leaving the app and a closed page make none, and a popup's first screen is where its moves start. It records, never reads a page's answer, and never
// fails a test. Left open: a test that moves the page from its own script (`page.evaluate` setting `location`) would read
// as the app's move; no journey test does (the crawl does, and its moves are not read: menu-reach.mjs reads steps only).
export const BETA_MOVES = 'beta moves';
const DIRECT = ['goto', 'reload', 'goBack', 'goForward'];

/** `customer(url)`: whether the URL is the customer app's (journey-reach.mjs servesCustomer). */
export function makeMoves(customer) {
  const pages = new Set();
  let now = null;
  /** { path, typed }: the customer-app path a URL shows (no trailing slash), and whether it carries a query or fragment. */
  const where = (url) => {
    try {
      if (!customer(url)) return { path: null, typed: false };
      const u = new URL(url);
      return { path: u.pathname.replace(/\/+$/, '') || '/', typed: Boolean(u.search || u.hash) };
    } catch {
      return { path: null, typed: false };
    }
  };
  return {
    /** Records this page's own moves from now on, and wraps its typed entries so they make none. */
    watch(page) {
      if (pages.has(page)) return;
      pages.add(page);
      // `last`: where the next move starts, null when unknown; `direct`: typed entries running; `typed`: entered by an
      // address that set its own state, so no move counts until the next plain typed entry.
      const state = { last: null, direct: 0, typed: false };
      // A goto is typed when its own address carries a query or fragment (one the app adds as it loads is the app's); a
      // reload keeps what the page had; a step back or forward is judged by the address it lands on.
      const entered = (name, args) => {
        const at = where(page.url());
        if (name === 'goto') state.typed = /[?#]/.test(String(args[0] ?? ''));
        else if (name !== 'reload') state.typed = at.typed;
        state.last = state.typed ? null : at.path;
      };
      // A page seen first on a screen (a popup) starts from it, judged by its address as a step back is.
      entered('watch', []);
      for (const name of DIRECT) {
        const own = page[name];
        if (typeof own !== 'function') continue;
        page[name] = async (...args) => {
          state.direct += 1;
          try {
            return await own.apply(page, args);
          } finally {
            state.direct -= 1;
            try {
              if (!state.direct) entered(name, args);
            } catch {
              /* recording never fails a test */
            }
          }
        };
      }
      page.on('close', () => {
        pages.delete(page);
        state.last = null;
      });
      page.on('framenavigated', (frame) => {
        try {
          if (frame !== page.mainFrame() || state.direct) return;
          const { path } = where(frame.url());
          if (state.typed) return;
          if (now && state.last && path && state.last !== path) now.add(JSON.stringify([state.last, path]));
          state.last = path;
        } catch {
          /* recording never fails a test */
        }
      });
    },
    /** A test begins: the moves made from now on are its own. */
    begin() {
      now = new Set();
      return now;
    },
    /** The test ended: its annotation, or null when it made no move. */
    end(seen) {
      if (now === seen) now = null;
      return seen.size ? { type: BETA_MOVES, description: JSON.stringify([...seen].sort().map((m) => JSON.parse(m))) } : null;
    },
  };
}
