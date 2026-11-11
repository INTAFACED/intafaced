/**
 * A response read from the page's next navigation only (docs/runbooks/harness-rewrite-plan.md, piece 7). A wait set up
 * before a reload or a `goto` can match a request the old page made just before it, and the navigation then drops that
 * response's body: "No resource with given identifier found" (#7457, J-wallet-04 #4 on three PR runs), or "the response
 * was navigated away from". So the match starts only once the navigation has committed the main frame, and the body is
 * read as soon as the response arrives, before anything else can move the page on.
 *
 * Returns `{ res, doc }`: `res` is `{ status, startedAt, body }` (`startedAt` is the request's start on the browser's
 * clock, `body` what `read` made of it, JSON by default), and `doc` is what `navigate` returned (the new document's
 * response for `page.reload()` or `page.goto()`). The caller checks them; this asserts nothing.
 */
export async function responseAfterNavigation(page, match, { navigate = () => page.reload(), read = (r) => r.json() } = {}) {
  let navigated = false;
  const committed = (frame) => {
    if (frame === page.mainFrame()) navigated = true;
  };
  page.on('framenavigated', committed);
  try {
    const answer = page
      .waitForResponse((r) => navigated && match(r))
      .then(async (r) => ({ status: r.status(), startedAt: r.request().timing().startTime, body: await read(r) }));
    const [res, doc] = await Promise.all([answer, navigate()]);
    return { res, doc };
  } finally {
    page.off('framenavigated', committed);
  }
}
