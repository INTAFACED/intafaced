// The customer app's screens each journey test showed, for the hosted beta's check (tooling/ci/journey-verdict.mjs
// `notOnBeta`, owner decision 24 Nov 2026: a step counts as proven only when it passes on the build the beta serves).
// apps/customer/tests/real-app/journey.mjs watches every page of every context it watches, and annotates each test with
// what was recorded while it ran (`beta screens`): the path of every main-frame navigation (a `goto`, a link, the app's
// own history changes), and the path each open page already showed as the test began (a step that goes on with a page an
// earlier step left open). It records, never reads a page's answer, and never fails a test.
export const BETA_SCREENS = 'beta screens';

/** `customer(url)`: whether the URL is the customer app's (journey-reach.mjs servesCustomer). */
export function makeScreens(customer) {
  const pages = new Set();
  let now = null;
  const note = (url) => {
    try {
      if (now && customer(url)) now.add(new URL(url).pathname);
    } catch {
      /* recording never fails a test */
    }
  };
  return {
    /** Records this page's main-frame navigations from now on. */
    watch(page) {
      if (pages.has(page)) return;
      pages.add(page);
      page.on('close', () => pages.delete(page));
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) note(frame.url());
      });
    },
    /** A test begins: what each open page shows is its first screens. */
    begin() {
      now = new Set();
      for (const page of pages) if (!page.isClosed()) note(page.url());
      return now;
    },
    /** The test ended: its annotation, or null when it showed no screen of the customer app. */
    end(seen) {
      if (now === seen) now = null;
      return seen.size ? { type: BETA_SCREENS, description: JSON.stringify([...seen].sort()) } : null;
    },
  };
}
