import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { LOOK_KEY } from './look';

/** Where the layout preference lives (shared/preferences.ts, held equal by boot.test.ts); Simple unless it says Pro. */
export const VIEW_KEY = 'intafaced.customer.view.v1';
/** The paths that draw Home: `/` sends a signed-in person there, and a signed-out one sees the frame only until the app runs. */
const HOME_PATHS = ['/', '/home', '/home/'];
/** The longest the frame may stand in for the app: past it, #root shows whatever the app has (its own loading or error). */
const FRAME_CAP_MS = 8000;

/**
 * The boot script: a classic, same-origin file (the CSP allows no inline script) that runs before the app's module.
 * It sets the remembered look on the root first, as look.ts will (`?look=` wins; it stores nothing itself), so the
 * first paint already has the look's shapes. On Simple Home's paths it marks the page (`data-boot="home"`), so
 * index.html's static frame shows and #root waits hidden, and it takes the mark off once Home's root is in #root, or
 * once #root shows something other than Home with no loading state left (a signed-out landing page, a refusal). Pro
 * Home has another layout, so it gets no frame (a Pro choice kept only on the account, not yet on this device, shows
 * the Simple frame until the app runs). It reads nothing but the path, the query, the look and layout preferences and
 * #root. On any error of its own, a resource that fails to load, an uncaught error or after FRAME_CAP_MS, it takes the
 * mark off, so a failed start shows the app's own state rather than a skeleton that never ends.
 *
 * It preloads nothing: measured on the phone profiles, fetching Home's chunk alongside the entry moved LCP by nothing
 * on fast 4G (CPU-bound) and made it later on slow 4G (the same bytes, competing with the entry).
 */
export const BOOT_SCRIPT = `(function () {
  var html = document.documentElement;
  try {
    var look = new URLSearchParams(location.search).get('look');
    if (look !== 'lit' && look !== 'off') {
      try { look = localStorage.getItem(${JSON.stringify(LOOK_KEY)}); } catch (e) {}
    }
    if (look === 'lit') html.setAttribute('data-look', 'lit');
  } catch (e) {}
  try {
    if (${JSON.stringify(HOME_PATHS)}.indexOf(location.pathname) < 0) return;
    var view = {};
    try { view = JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}) || '{}') || {}; } catch (e) {}
    if (view.layoutMode === 'pro') return;
    html.setAttribute('data-boot', 'home');
    // Home's root ends the frame; before it, the shell and its loading states ("Opening room…") are still the frame's
    // to cover, and any other content with no loading state left is not Home. Checked once per DOM batch, and the
    // watch ends with the frame
    var settle = function () {
      var root = document.getElementById('root');
      if (!root) return false;
      if (root.querySelector('[data-testid="if-home"]')) return true;
      return !root.querySelector('.loading') && root.textContent.trim() !== '';
    };
    var done = function () {
      html.removeAttribute('data-boot');
      watch.disconnect();
      removeEventListener('error', done, true);
      clearTimeout(cap);
    };
    var watch = new MutationObserver(function () {
      if (settle()) done();
    });
    watch.observe(document, { childList: true, subtree: true, characterData: true });
    // a script or stylesheet that fails to load, or an uncaught error, ends the frame (capture: load errors don't bubble)
    addEventListener('error', done, true);
    var cap = setTimeout(done, ${FRAME_CAP_MS});
  } catch (e) {
    html.removeAttribute('data-boot');
  }
})();
`;

/**
 * Publishes the boot script under /assets/ with its own content hash (immutable like every asset, and index.html's only
 * script outside the module graph is still a same-origin /assets/ file) and loads it in index.html's head, after the
 * title and ahead of the app's stylesheet and module.
 */
export function homeBoot(): Plugin {
  let base = '/';
  return {
    name: 'intafaced:home-boot',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      const fileName = `assets/boot-${createHash('sha256').update(BOOT_SCRIPT).digest('hex').slice(0, 10)}.js`;
      this.emitFile({ type: 'asset', fileName, source: BOOT_SCRIPT });
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset' || typeof html.source !== 'string') return this.error('home-boot: index.html is missing');
      if (!html.source.includes('</title>')) return this.error('home-boot: index.html has no <title>');
      html.source = html.source.replace('</title>', `</title>\n    <script src="${base}${fileName}"></script>`);
    },
  };
}
