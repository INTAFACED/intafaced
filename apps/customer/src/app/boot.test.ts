// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOT_SCRIPT, homeBoot } from './boot';

const VIEW_KEY = 'intafaced.customer.view.v1';
const html = document.documentElement;

/** Runs the boot script as the browser would, on a page with an empty #root. */
function boot(path: string, view?: object) {
  history.replaceState(null, '', path);
  localStorage.clear();
  if (view) localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  html.removeAttribute('data-boot');
  document.body.innerHTML = '<div id="boot-frame"></div><div id="root"></div>';
  new Function(BOOT_SCRIPT)();
  return document.getElementById('root')!;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  html.removeAttribute('data-boot');
  localStorage.clear();
});

describe('the boot script', () => {
  it('marks Simple Home on its paths, and nothing else', () => {
    for (const path of ['/', '/home', '/home/']) {
      boot(path);
      expect(html.getAttribute('data-boot'), path).toBe('home');
    }
    for (const path of ['/trade', '/money', '/homes', '/home/x']) {
      boot(path);
      expect(html.hasAttribute('data-boot'), path).toBe(false);
    }
  });

  it('leaves Pro Home unmarked, and reads a broken preference as Simple', () => {
    boot('/home', { layoutMode: 'pro' });
    expect(html.hasAttribute('data-boot')).toBe(false);
    history.replaceState(null, '', '/home');
    localStorage.setItem(VIEW_KEY, '{not json');
    new Function(BOOT_SCRIPT)();
    expect(html.getAttribute('data-boot')).toBe('home');
  });

  it("keeps the frame through the app's loading state, and drops it when the app draws its own content", async () => {
    const root = boot('/home');
    root.innerHTML =
      '<div class="legacy-room"><div class="page"><div class="loading" role="status"><span></span>Opening room…</div></div></div>';
    await flush();
    expect(html.getAttribute('data-boot')).toBe('home');
    root.innerHTML = '<header class="tb">intafaced</header><main><h2>Needs you</h2></main>';
    await flush();
    expect(html.hasAttribute('data-boot')).toBe(false);
  });

  it('drops the frame for any content that is not the loading state, a signed-out landing page included', async () => {
    const root = boot('/');
    root.innerHTML = '<div class="legacy-room"><h1>Your money, trading and payments</h1></div>';
    await flush();
    expect(html.hasAttribute('data-boot')).toBe(false);
  });
});

describe('index.html and the frame', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');

  it('shows the frame and hides #root only while the page is marked', () => {
    expect(source).toMatch(/#boot-frame,\s*html\[data-boot='home'\] #root \{\s*display: none;/);
    expect(source).toMatch(/html\[data-boot='home'\] #boot-frame \{\s*display: block;/);
  });

  it('holds no figures and no words but the wordmark, and is hidden from assistive technology', () => {
    const frame = source.slice(source.indexOf('<div id="boot-frame"'), source.indexOf('<div id="root">'));
    expect(frame).toContain('aria-hidden="true"');
    expect(frame.replace(/<[^>]+>/g, '').replace(/\s+/g, '')).toBe('intafaced·');
  });

  it('draws the wordmark in the system face, so it starts no web font download', () => {
    const rule = source.slice(source.indexOf('#boot-frame .bf-top {'), source.indexOf('#boot-frame .bf-top span'));
    expect(rule).toMatch(/font: 700 [^;]*system-ui, sans-serif;/);
    expect(rule).not.toMatch(/--if-font|Inter/);
  });
});

describe('the build plugin', () => {
  it('publishes the script under /assets/ with a content hash and loads it after the title', () => {
    const emitted: Array<{ fileName: string; source: string }> = [];
    const bundle: Record<string, { type: 'asset'; source: string }> = {
      'index.html': {
        type: 'asset',
        source: '<head><title>Intafaced</title><script type="module" src="/assets/index.js"></script></head>',
      },
    };
    const plugin = homeBoot();
    (plugin.configResolved as (config: { base: string }) => void)({ base: '/' });
    (plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void).call(
      {
        emitFile: (file: { fileName: string; source: string }) => emitted.push(file),
        error: (message: string) => {
          throw new Error(message);
        },
      },
      {},
      bundle,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.fileName).toMatch(/^assets\/boot-[0-9a-f]{10}\.js$/);
    expect(emitted[0]!.source).toBe(BOOT_SCRIPT);
    expect(bundle['index.html']!.source).toMatch(
      new RegExp(`</title>\\n    <script src="/${emitted[0]!.fileName}"></script><script type="module"`),
    );
  });
});
