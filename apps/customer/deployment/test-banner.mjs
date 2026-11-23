// The TEST banner is the Customer build's own: every build carries it in its index.html unless it is built for real
// money (`VITE_MONEY=real`), so a deployed test build shows it as the local stack does, and a real-money build never
// can. The local stack serves the build as built (tooling/scripts/local-test-stack.mjs) and reads BANNER_TEXT from here.
// The app reads the banner's id (src/shared/test-build.ts) to label a test build's money.

/** The words the banner shows; the local stack's status and the beta host's funds check look for them. */
export const BANNER_TEXT = 'LOCAL TEST STACK — TEST PRICES · TEST FUNDS · not real money';

/** The banner's element id (src/shared/test-build.ts, TEST_BUILD_BANNER_ID). */
export const BANNER_ID = 'local-test-stack-banner';

// The banner as the local stack's proxy drew it, unchanged, so no picture moves.
export const BANNER_HTML =
  `<style>body{padding-top:28px !important}</style>` + // look-drift-allow: room for the TEST banner's fixed strip, moved unchanged
  `<div id="${BANNER_ID}" role="status" style="position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;` + // look-drift-allow: the TEST banner's fixed warning strip, moved unchanged from the local stack
  `display:flex;align-items:center;justify-content:center;background:#F5A915;color:#0b0b0b;` + // look-drift-allow: the TEST banner's own warning colours
  `font:600 12px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.04em;text-align:center;` + // look-drift-allow: the TEST banner's own type
  `pointer-events:none;user-select:none">${BANNER_TEXT}</div>`;

/** The money a build is for. Blank or `test`: test money. `real`: real money. Anything else is refused. */
export function moneyMode(env = process.env) {
  const value = (env.VITE_MONEY ?? '').trim();
  if (value === '' || value === 'test') return 'test';
  if (value === 'real') return 'real';
  throw new Error(`VITE_MONEY must be blank, "test" or "real", not "${value}"`);
}

/**
 * The page a build serves: a test build's index.html with the banner first in its body; a real-money build's as it
 * is, and a real-money page that already carries a banner is refused, so a stray copy can never ship.
 */
export function withTestBanner(html, env = process.env) {
  if (moneyMode(env) === 'real') {
    if (html.includes(`id="${BANNER_ID}"`)) throw new Error('a real-money build carries the TEST banner');
    return html;
  }
  if (html.includes(`id="${BANNER_ID}"`)) return html;
  if (!/<body[^>]*>/i.test(html)) throw new Error('the page has no <body> to carry the TEST banner');
  return html.replace(/<body([^>]*)>/i, (m) => `${m}${BANNER_HTML}`);
}

/** The build's page step (vite.config.ts): a test build's page carries the banner, a real-money build's never does. */
export function testBanner(env = process.env) {
  return { name: 'intafaced-test-banner', transformIndexHtml: (html) => withTestBanner(html, env) };
}
