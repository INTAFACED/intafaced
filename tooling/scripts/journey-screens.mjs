// The customer app's screens each journey test showed, for the hosted beta's check (tooling/ci/journey-verdict.mjs
// `notOnBeta`, owner decision 24 Nov 2026: a step counts as proven only when it passes on the build the beta serves).
// apps/customer/tests/real-app/journey.mjs watches every page of every context it watches, and annotates each test with
// what was recorded while it ran (`beta screens`): the path of every main-frame navigation (a `goto`, a link, the app's
// own history changes), and the path each open page already showed as the test began (a step that goes on with a page an
// earlier step left open). It records, never reads a page's answer, and never fails a test.
// A page belongs to the journey file that opened it, and only its own file's tests record what it shows: a page another
// file left open is not this file's screen. (Failure it prevents: in run 11655 J-campaigns-04 left /uc/promotion and
// /wallet/venue open, and every step of the three files after it in that worker was marked not on the beta for them.)
export const BETA_SCREENS = 'beta screens';

/** `customer(url)`: whether the URL is the customer app's (journey-reach.mjs servesCustomer). */
export function makeScreens(customer) {
  const pages = new Map(); // page -> the journey file that opened it, or null when no file was running
  let file = null;
  let now = null;
  const own = (page) => {
    const owner = pages.get(page);
    return owner == null || owner === file;
  };
  const note = (page, url) => {
    try {
      if (now && own(page) && customer(url)) now.add(new URL(url).pathname);
    } catch {
      /* recording never fails a test */
    }
  };
  return {
    /** The journey file running now: only the pages it opened (and those no file opened) record its screens. */
    enter(next) {
      file = next ?? null;
    },
    /** Records this page's main-frame navigations from now on; `owner` is the journey file that opened it. */
    watch(page, owner = null) {
      if (pages.has(page)) return;
      pages.set(page, owner ?? null);
      // A popup is seen only once it has navigated: what it shows now is a screen of this test.
      note(page, page.url());
      page.on('close', () => pages.delete(page));
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) note(page, frame.url());
      });
    },
    /** A test begins: what each of its own file's open pages shows is its first screens. */
    begin() {
      now = new Set();
      for (const page of pages.keys()) if (!page.isClosed()) note(page, page.url());
      return now;
    },
    /** The test ended: its annotation, or null when it showed no screen of the customer app. */
    end(seen) {
      if (now === seen) now = null;
      return seen.size ? { type: BETA_SCREENS, description: JSON.stringify([...seen].sort()) } : null;
    },
  };
}

/**
 * The browser contexts each journey file opened, from the test or hook that was running as it opened them (journey.mjs),
 * so the next file's first hook or test closes what the last file left open: its pages then show no screen and run no
 * code in the next file's records. A context no file opened (a worker fixture's) is never closed here, and a file's own
 * contexts stay open for all of its tests and hooks (a `test.beforeAll` page reused by its steps).
 */
export function makeFileContexts() {
  const owners = new WeakMap(); // context -> the journey file that opened it
  const open = new Set();
  return {
    /** `context` was opened while journey file `file` ran (null: outside any file, never closed here). */
    opened(context, file) {
      if (!file || owners.has(context)) return;
      owners.set(context, file);
      open.add(context);
      context.on('close', () => open.delete(context));
    },
    /** The journey file that opened this context, or null. */
    ownerOf(context) {
      return owners.get(context) ?? null;
    },
    /** File `file` begins: every context another file opened is closed with `close`, whose failure is not this file's. */
    async enter(file, close) {
      const left = [...open].filter((context) => owners.get(context) !== file);
      for (const context of left) {
        open.delete(context);
        try {
          await close(context);
        } catch {
          /* already closed, or the browser is gone: nothing of it is left to show */
        }
      }
      return left.length;
    },
  };
}
