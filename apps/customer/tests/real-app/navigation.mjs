/**
 * A response read from the page's next navigation only (docs/runbooks/harness-rewrite-plan.md, piece 7). A wait set up
 * before a reload or a `goto` can match a request the old page made just before it, and the navigation then drops that
 * response's body: "No resource with given identifier found" (#7457, J-wallet-04 #4 on three PR runs), or "the response
 * was navigated away from". So the match starts only once the navigation has committed the main frame, and the body is
 * read as soon as the response arrives, before anything else can move the page on. A read the old page started before the
 * navigation can still answer after the commit (#8061, J-wallet-04 #4: a rename's own re-read of the book, then a reload),
 * so the match also needs the request to have started no earlier than the navigation's own document request did (both
 * times from the browser's clock): such an old read is never the one matched, and its dropped body is never read.
 *
 * Returns `{ res, doc }`: `res` is `{ status, startedAt, body }` (`startedAt` is the request's start on the browser's
 * clock, `body` what `read` made of it, JSON by default), and `doc` is what `navigate` returned (the new document's
 * response for `page.reload()` or `page.goto()`). The caller checks them; this asserts nothing.
 */
export async function responseAfterNavigation(page, match, { navigate = () => page.reload(), read = (r) => r.json() } = {}) {
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
    const answer = page
      .waitForResponse((r) => navigated && fresh(r) && match(r))
      .then(async (r) => ({ status: r.status(), startedAt: r.request().timing().startTime, body: await read(r) }));
    const [res, doc] = await Promise.all([answer, navigate()]);
    return { res, doc };
  } finally {
    page.off('framenavigated', committed);
    page.off('request', requested);
  }
}

/**
 * The answers to the page's next navigation only, one per `match`, each read whole as it arrives (the same rule as
 * `responseAfterNavigation`): a request the old page made just before the navigation can't answer, and the navigation
 * can't drop an answer's body before the test reads it. `navigate` is awaited to its end first, as a plain `goto` or
 * `reload` would be. Each answer is a snapshot that reads like Playwright's Response (`url()`, `status()`, `ok()`,
 * `headers()`, `request()`, and `text()` and `json()` from the body read on arrival), so a step checks it as before.
 * `timeout` is each wait's own, as `waitForResponse` takes it.
 *
 * Every response wait that spans a `goto` or `reload` in a journey goes through here
 * (tooling/scripts/journey-navigation.test.mjs). Failures it prevents: J-home-ia-06 #1 (#7452), J-charts-desk-09 #1
 * (#7919), J-wallet-04 #4 (#7457).
 */
export async function answersAfterNavigation(page, matches, navigate, { timeout } = {}) {
  let navigated = false;
  const committed = (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  };
  page.on('framenavigated', committed);
  try {
    const waits = matches.map((match) =>
      page
        .waitForResponse(async (r) => navigated && (await match(r)), timeout === undefined ? {} : { timeout })
        .then(async (r) => {
          let body = null;
          let failed = null;
          try {
            body = await r.text();
          } catch (err) {
            failed = err;
          }
          const text = async () => {
            if (failed) throw failed;
            return body;
          };
          return {
            url: () => r.url(),
            status: () => r.status(),
            ok: () => r.ok(),
            headers: () => r.headers(),
            request: () => r.request(),
            text,
            json: async () => JSON.parse(await text()),
          };
        })
        .then(
          (answer) => ({ answer }),
          (error) => ({ error }),
        ),
    );
    await navigate();
    const settled = await Promise.all(waits);
    for (const s of settled) if (s.error) throw s.error;
    return settled.map((s) => s.answer);
  } finally {
    page.off('framenavigated', committed);
  }
}

/** The one answer to the page's next navigation that `match` names (`answersAfterNavigation`). */
export async function answerAfterNavigation(page, match, navigate, options) {
  const [answer] = await answersAfterNavigation(page, [match], navigate, options);
  return answer;
}
