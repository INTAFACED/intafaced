// The TEST banner is the Customer build's own: every build carries it in its index.html unless it is built for real
// money (`VITE_MONEY=real`), so a deployed test build shows it as the local stack does, and a real-money build never
// can. The local stack serves the build as built (tooling/scripts/local-test-stack.mjs) and reads BANNER_TEXT from here.
// The app reads the banner's id (src/shared/test-build.ts) to label a test build's money.

/** The words the banner shows; the local stack's status and the beta host's funds check look for them. */
export const BANNER_TEXT = 'TEST NETWORK · TEST PRICES · TEST FUNDS · not real money';

/** The banner's element id (src/shared/test-build.ts, TEST_BUILD_BANNER_ID). */
export const BANNER_ID = 'local-test-stack-banner';

// The banner drawn as part of the product: a thin dark strip under a warm amber hairline, a steady amber dot and the
// words in the kit's interface face, so a tester reads it at once without it looking like a debug bar. Its text stays
// exactly BANNER_TEXT (the dot is drawn by CSS, never as text). The look gate judges every page it is on.
export const BANNER_HTML =
  `<style>body{padding-top:28px !important}` + // look-drift-allow: room for the TEST banner's fixed strip
  `#${BANNER_ID}::before{content:"";inline-size:6px;block-size:6px;border-radius:50%;background:#F5A915;` + // look-drift-allow: the TEST banner's amber dot
  `box-shadow:0 0 8px rgba(245,169,21,.6)}` + // look-drift-allow: the dot's soft glow
  `@media (max-width:420px){#${BANNER_ID}{gap:6px !important;letter-spacing:.02em !important;font-size:10px !important}}</style>` + // look-drift-allow: a phone's narrower strip
  `<div id="${BANNER_ID}" role="status" style="position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;` + // look-drift-allow: the TEST banner's fixed strip
  `display:flex;align-items:center;justify-content:center;gap:10px;` + // look-drift-allow: the dot's spacing
  `background:linear-gradient(180deg,#17130b,#0e0c08);box-shadow:inset 0 -1px 0 rgba(245,169,21,.28);color:#F0C46A;` + // look-drift-allow: the TEST banner's own warm tones
  `font:500 11px/1 var(--lit-font-ui);letter-spacing:.08em;text-align:center;` + // look-drift-allow: the TEST banner's size, in the kit's interface face
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
