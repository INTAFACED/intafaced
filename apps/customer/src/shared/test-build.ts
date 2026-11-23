/**
 * Whether this page was served by a test build. Every build not made for real money carries the TEST banner in its
 * page, `<div id="local-test-stack-banner">` (deployment/test-banner.mjs), wherever it is served; a real-money build
 * (`VITE_MONEY=real`) carries none.
 * It adds a TEST label to money a test build shows, and the sign-in page's Tester build panel, which names files and
 * commands only (never a password, a second-factor secret or a code): a missing banner hides nothing, and a forged one
 * reveals nothing.
 */
export const TEST_BUILD_BANNER_ID = 'local-test-stack-banner';

const read = (doc: Pick<Document, 'getElementById'> | undefined): boolean => Boolean(doc?.getElementById(TEST_BUILD_BANNER_ID));

let served: boolean | undefined;

/** The banner is fixed when the page is served, so the page's own answer is read once. */
export function isTestBuild(doc?: Pick<Document, 'getElementById'>): boolean {
  if (doc) return read(doc);
  return (served ??= read(globalThis.document));
}
