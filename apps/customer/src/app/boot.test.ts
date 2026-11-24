// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOT_SCRIPT, VIEW_KEY, homeBoot } from './boot';
import { savePreferences } from '../shared/preferences';

const here = dirname(fileURLToPath(import.meta.url));
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
  vi.useRealTimers();
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

  it("keeps the frame through the shell and its loading state, and drops it when Home's root is in #root", async () => {
    const root = boot('/home');
    root.innerHTML =
      '<header class="tb">intafaced</header><main><div class="legacy-room"><div class="page"><div class="loading" role="status"><span></span>Opening room…</div></div></div></main>';
    await flush();
    expect(html.getAttribute('data-boot')).toBe('home');
    root.querySelector('main')!.innerHTML = '<div data-testid="if-home" class="if-home"></div>';
    await flush();
    expect(html.hasAttribute('data-boot')).toBe(false);
  });

  it('drops the frame for content that is not Home once no loading state is left', async () => {
    const root = boot('/');
    root.innerHTML = '<header class="tb">intafaced</header><main><div class="loading">Loading…</div></main>';
    await flush();
    expect(html.getAttribute('data-boot')).toBe('home');
    root.querySelector('main')!.innerHTML = '<div class="legacy-room"><h1>Your money, trading and payments</h1></div>';
    await flush();
    expect(html.hasAttribute('data-boot')).toBe(false);
  });

  it('drops the frame when a script fails to load, on an uncaught error, and after its time cap', async () => {
    boot('/home');
    const script = document.createElement('script');
    document.head.append(script);
    script.dispatchEvent(new Event('error'));
    expect(html.hasAttribute('data-boot')).toBe(false);
    boot('/home');
    window.dispatchEvent(new Event('error'));
    expect(html.hasAttribute('data-boot')).toBe(false);
    vi.useFakeTimers();
    boot('/home');
    vi.advanceTimersByTime(7999);
    expect(html.getAttribute('data-boot')).toBe('home');
    vi.advanceTimersByTime(1);
    expect(html.hasAttribute('data-boot')).toBe(false);
  });

  it('notices a text-only change inside #root', async () => {
    const root = boot('/');
    root.innerHTML = '<div></div>';
    await flush();
    expect(html.getAttribute('data-boot')).toBe('home');
    root.firstElementChild!.append(document.createTextNode(''));
    await flush();
    expect(html.getAttribute('data-boot')).toBe('home');
    root.firstElementChild!.lastChild!.textContent = 'Sign in';
    await flush();
    expect(html.hasAttribute('data-boot')).toBe(false);
  });

  it('reads the key the app keeps its layout preference under: a Pro choice the app saved leaves Home unmarked', () => {
    history.replaceState(null, '', '/home');
    localStorage.clear();
    savePreferences({ layoutMode: 'pro' });
    expect(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}')).toMatchObject({ layoutMode: 'pro' });
    html.removeAttribute('data-boot');
    new Function(BOOT_SCRIPT)();
    expect(html.hasAttribute('data-boot')).toBe(false);
    savePreferences({ layoutMode: 'simple' });
    new Function(BOOT_SCRIPT)();
    expect(html.getAttribute('data-boot')).toBe('home');
  });

  it('sets no look: Volt is on the root from index.html, whatever the query says', () => {
    for (const path of ['/home', '/trade', '/home?look=off', '/home?look=off&direction=x']) {
      boot(path);
      expect(html.hasAttribute('data-look'), path).toBe(false);
      expect(html.hasAttribute('data-direction'), path).toBe(false);
    }
  });
});

describe('index.html and the frame', () => {
  const source = readFileSync(join(here, '../../index.html'), 'utf8');

  it('shows the frame and hides #root only while the page is marked', () => {
    expect(source).toMatch(/#boot-frame,\s*html\[data-boot='home'\] #root \{\s*display: none;/);
    expect(source).toMatch(/html\[data-boot='home'\] #boot-frame \{\s*display: block;/);
  });

  it('holds no figures and no words, only the brand, and is hidden from assistive technology', () => {
    const frame = source.slice(source.indexOf('<div id="boot-frame"'), source.indexOf('<div id="root">'));
    expect(frame).toContain('aria-hidden="true"');
    expect(frame).toContain('<span class="bf-brand"></span>');
    expect(frame.replace(/<[^>]+>/g, '').replace(/\s+/g, '')).toBe('');
  });

  it('keeps the no-eval setting ahead of the app module', () => {
    expect(source).toMatch(/<script src="\/assets\/no-eval-v1\.js"><\/script>\s*<script type="module"/);
  });

  it('takes every colour and size from the kit tokens or rem, never a hex or pixel value', () => {
    const style = source.slice(source.indexOf('<style>'), source.indexOf('</style>'));
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(style.replace(/1px solid/g, '')).not.toMatch(/\d+px/);
  });

  it('draws the brand as the app bar does, from the kit files in the text colour, and starts no web font download', () => {
    const style = source.slice(source.indexOf('<style>'), source.indexOf('</style>'));
    const rule = style.slice(style.indexOf('#boot-frame .bf-brand {'));
    expect(rule).toMatch(/mask: url\(\/brand\/lockup-topbar\.svg\)/);
    expect(rule).toMatch(/background: var\(--if-text\)/);
    expect(style).toMatch(/mask-image: url\(\/brand\/mark-small\.svg\)/);
    expect(style).not.toMatch(/--if-font|Inter/);
    for (const file of ['lockup-topbar.svg', 'mark-small.svg']) expect(existsSync(join(here, '../../public/brand', file))).toBe(true);
  });

  it('names the tab, the home-screen icon and the shared link with the brand files', () => {
    for (const href of [
      '/brand/favicon.svg',
      '/brand/favicon-32.png',
      '/brand/apple-touch-icon-180.png',
      '/manifest.webmanifest',
      '/brand/og-image.png',
    ])
      expect(source).toContain(`"${href}"`);
    const manifest = JSON.parse(readFileSync(join(here, '../../public/manifest.webmanifest'), 'utf8')) as { icons: { src: string }[] };
    for (const icon of manifest.icons) expect(existsSync(join(here, '../../public', icon.src))).toBe(true);
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
