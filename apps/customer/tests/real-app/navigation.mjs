/**
 * The one way a journey reads an answer the page gets after a `reload` or a `goto` (docs/runbooks/harness-rewrite-plan.md,
 * piece 7). `garden/no-stale-read` refuses every other way in apps/customer/tests/real-app: a `waitForResponse` kept
 * across a navigation, one raced against it in a `Promise.all`, or a hand-made `framenavigated` match.
 *
 * Why each rule below holds:
 * - A wait set up before the navigation can match a request the old page made just before it, and the navigation then
 *   drops that answer's body: "No resource with given identifier found" (#7457, J-wallet-04 #4 on three PR runs), or "the
 *   response was navigated away from" (J-charts-desk-09 #1, #7919). So a match counts only once the navigation has
 *   committed the main frame.
 * - A read the old page started before the navigation can still answer after the commit (#8061, J-wallet-04 #4: a rename's
 *   own re-read of the book, then a reload). So a match also needs its request to have started no earlier than the
 *   navigation's own document request did, both times from the browser's clock.
 * - The body is read inside the wait, as each fresh match arrives, before anything else can move the page on. A match
 *   whose body the browser no longer holds is a request the new page itself let go of (aborted and asked again, or left by
 *   a further navigation), never an answer the test can check: the wait takes the page's next match instead (J-wallet-04 #7
 *   on #8634). Any other read error fails at once, and a wait that sees only such bodies fails with the browser's own error.
 */

/** The browser's words for a response body it no longer holds (Chromium's Network.getResponseBody). */
export const GONE = /No (?:data found for resource|resource) with given identifier/;

/**
 * The answers to the page's next navigation only, one per `match`, each read whole as it arrives. `navigate` (for example
 * `() => page.reload()` or `() => page.goto('/x')`) is awaited to its end first, as a plain `goto` or `reload` would be.
 * Each answer is a snapshot that reads like Playwright's Response (`url()`, `status()`, `ok()`, `headers()`, `request()`,
 * and `text()` and `json()` from the body read on arrival), so a step checks it as before. `timeout` is each wait's own, as
 * `waitForResponse` takes it. The caller checks the answers; this asserts nothing.
 */
export async function answersAfterNavigation(page, matches, navigate, { timeout } = {}) {
  let navigated = false;
  let docRequest = null;
  const committed = (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  };
  const requested = (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) docRequest = req;
  };
  // Playwright fills a request's start time when its answer arrives; the document's answer arrives before the commit.
  const fresh = (r) => {
    const since = docRequest?.timing().startTime ?? 0;
    return since > 0 && r.request().timing().startTime >= since;
  };
  page.on('request', requested);
  page.on('framenavigated', committed);
  try {
    const waits = matches.map((match) => {
      let gone = null;
      let answer = null;
      return page
        .waitForResponse(
          async (r) => {
            if (!(navigated && fresh(r) && (await match(r)))) return false;
            let body;
            try {
              body = await r.text();
            } catch (err) {
              if (!GONE.test(String(err?.message))) throw err;
              gone = err;
              return false;
            }
            answer = {
              url: () => r.url(),
              status: () => r.status(),
              ok: () => r.ok(),
              headers: () => r.headers(),
              request: () => r.request(),
              text: async () => body,
              json: async () => JSON.parse(body),
            };
            return true;
          },
          timeout === undefined ? {} : { timeout },
        )
        .then(
          () => ({ answer }),
          (error) => ({ error: gone ?? error }),
        );
    });
    await navigate();
    const settled = await Promise.all(waits);
    for (const s of settled) if (s.error) throw s.error;
    return settled.map((s) => s.answer);
  } finally {
    page.off('framenavigated', committed);
    page.off('request', requested);
  }
}

/** The one answer to the page's next navigation that `match` names (`answersAfterNavigation`). */
export async function answerAfterNavigation(page, match, navigate, options) {
  const [answer] = await answersAfterNavigation(page, [match], navigate, options);
  return answer;
}
