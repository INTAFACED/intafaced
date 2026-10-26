import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Where the layout preference lives (shared/preferences.ts); Simple unless it says Pro. */
const VIEW_KEY = 'intafaced.customer.view.v1';
/** The paths that draw Home: `/` sends a signed-in person there, and a signed-out one sees the frame only until the app runs. */
const HOME_PATHS = ['/', '/home', '/home/'];

/**
 * The boot script: a classic, same-origin file (the CSP allows no inline script) that runs before the app's module.
 * On Simple Home's paths it marks the page (`data-boot="home"`), so index.html's static frame shows and #root waits
 * hidden, and it takes the mark off as soon as the app shows more than its loading state. Pro Home has another layout,
 * so it gets no frame. It reads nothing but the path, the layout preference and #root's text, and on any error leaves
 * the page as it would be without it.
 *
 * It preloads nothing: measured on the phone profiles, fetching Home's chunk alongside the entry moved LCP by nothing
 * on fast 4G (CPU-bound) and made it later on slow 4G (the same bytes, competing with the entry).
 */
export const BOOT_SCRIPT = `(function () {
  var html = document.documentElement;
  try {
    if (${JSON.stringify(HOME_PATHS)}.indexOf(location.pathname) < 0) return;
    var view = {};
    try { view = JSON.parse(localStorage.getItem(${JSON.stringify(VIEW_KEY)}) || '{}') || {}; } catch (e) {}
    if (view.layoutMode === 'pro') return;
    html.setAttribute('data-boot', 'home');
    // #root's text is empty or only the loading label until the app has drawn something of its own; checked once per
    // DOM batch, and the watch ends with the frame
    var settle = function () {
      var root = document.getElementById('root');
      if (!root) return false;
      var loading = root.querySelector('.loading');
      var text = root.textContent.trim();
      if (text === '' || (loading && text === loading.textContent.trim())) return false;
      html.removeAttribute('data-boot');
      return true;
    };
    var watch = new MutationObserver(function () {
      if (settle()) watch.disconnect();
    });
    watch.observe(document, { childList: true, subtree: true });
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
