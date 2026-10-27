import { test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepRoutes } from './routes.mjs';
import { signUp, verify, signIn } from './desk.mjs';

// The room report: every customer room at one width, measured for contrast (axe), horizontal overflow, overlapping
// text, raw codes or keys on screen, CSS custom properties used but never defined, and colours that are not kit tokens.
// It reports and never fails: each room's numbers are an annotation on its own test, its screenshot is attached, and
// a summary table goes to the log and to look-report-<width>.md in the run's results folder (uploaded with the shard).
// Titles do not start with "J-", so the journey scoreboard and Main trust ignore it. One TEST person, signed up and
// verified at the start, so rooms open as a customer sees them; if that fails, the sweep runs signed out and says so.

export { sweepRoutes };

/** What one room shows, measured in the page. Runs in the browser. */
function measure() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const c = getComputedStyle(el);
    return c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0.05;
  };
  const doc = document.documentElement;
  const overflowX = Math.max(0, doc.scrollWidth - doc.clientWidth);

  // Text boxes that overlap another text box that is not their ancestor or descendant.
  const texts = [...document.querySelectorAll('body *')].filter(
    (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && visible(el),
  );
  const rects = texts.map((el) => el.getBoundingClientRect());
  const isText = new Set(texts);
  const name = (el) =>
    `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`;
  const overlaps = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (texts[i].contains(texts[j]) || texts[j].contains(texts[i])) continue;
      const a = rects[i];
      const b = rects[j];
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2 && w * h > 0.2 * Math.min(a.width * a.height, b.width * b.height)) {
        overlaps.push(`${name(texts[i])} × ${name(texts[j])}: "${texts[i].textContent.trim().slice(0, 30)}"`);
      }
    }
  }

  // Raw codes or i18n keys on screen: lower-case dotted words with an underscore, or three dotted parts.
  const KEY = /\b[a-z][a-z0-9]*(?:\.[a-z0-9]+)*\.[a-z0-9]*_[a-z0-9_]*\b|\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/g;
  const codes = { supportLine: [], elsewhere: [] };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;
    if (!el || !visible(el) || el.closest('script,style,noscript')) continue;
    for (const m of node.textContent.match(KEY) ?? []) {
      if (/\.(com|io|org|net|invalid|json|js|ts|css|png|svg)\b/.test(m)) continue;
      const support = el.closest('[data-slot="state-block"], [data-slot="empty-state-code"], [lang="zxx"]');
      (support ? codes.supportLine : codes.elsewhere).push(m);
    }
  }

  // Custom properties used without a fallback and declared nowhere. The kit's menus, tabs and accordions set their own
  // sizing names on the element while open, so those are left out.
  const RUNTIME = /^--(accordion-panel-|collapsible-panel-|anchor-|available-|popup-|positioner-|active-tab-|transform-origin)/;
  const used = new Set();
  const declared = new Set();
  const readRules = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules) readRules(rule.cssRules);
      const css = rule.cssText ?? '';
      for (const m of css.matchAll(/var\((--[\w-]+)\s*\)/g)) used.add(m[1]);
      for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      readRules(sheet.cssRules);
    } catch {
      // Cross-origin sheet: nothing of ours.
    }
  }
  for (const el of document.querySelectorAll('[style]'))
    for (const m of el.getAttribute('style').matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
  const undefinedVars = [...used].filter((n) => !RUNTIME.test(n) && !declared.has(n) && !getComputedStyle(doc).getPropertyValue(n)).sort();

  // Colours that are not a kit token's value (the older customer names count as off-token: they have their own values).
  const probe = document.createElement('i');
  document.body.append(probe);
  const tokenColours = new Set();
  const rootStyle = getComputedStyle(doc);
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules)
        if (rule.selectorText === ':root')
          for (const prop of rule.style) {
            if (!prop.startsWith('--if-')) continue;
            probe.style.color = '';
            probe.style.color = rootStyle.getPropertyValue(prop).trim();
            if (probe.style.color) tokenColours.add(getComputedStyle(probe).color);
          }
    } catch {
      // Cross-origin sheet.
    }
  }
  probe.remove();
  const off = new Map();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const c = getComputedStyle(el);
    const pairs = [];
    if (isText.has(el)) pairs.push(c.color);
    if (c.backgroundColor !== 'rgba(0, 0, 0, 0)') pairs.push(c.backgroundColor);
    for (const colour of pairs) if (!tokenColours.has(colour)) off.set(colour, (off.get(colour) ?? 0) + 1);
  }

  return {
    overflowX,
    overlaps: overlaps.length,
    overlapSamples: overlaps.slice(0, 5),
    codesElsewhere: [...new Set(codes.elsewhere)],
    codesInSupportLines: [...new Set(codes.supportLine)],
    undefinedVars,
    offTokenColours: [...off.entries()].sort((a, b) => b[1] - a[1]).map(([colour, n]) => `${colour} ×${n}`),
  };
}

/** Registers the sweep at `width` (one test per room) in the calling spec file. */
export function lookSweep(width, height) {
  test.describe.configure({ mode: 'serial' });
  const rows = [];
  let page;
  let signedIn = 'signed out';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    // The config's own options (base URL, the TEST device cookie) at this width; a page made here does not get them.
    const { baseURL, storageState } = test.info().project.use;
    try {
      page = await (await browser.newContext({ baseURL, storageState, viewport: { width, height } })).newPage();
      const who = await signUp(page, `look${width}`);
      await verify(page, who);
      await signIn(page, who);
      signedIn = 'signed in, verified';
    } catch (error) {
      signedIn = `signed out (sign-up failed: ${String(error?.message ?? error)
        .split('\n')[0]
        .slice(0, 120)})`;
    }
  });

  for (const route of sweepRoutes()) {
    test(`look sweep ${width} ${route}`, async () => {
      // Well above the step timeouts below, so a slow room becomes a row with an error rather than a failed test.
      test.setTimeout(120_000);
      const info = test.info();
      const row = { route };
      try {
        await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(500);
        Object.assign(row, await page.evaluate(measure));
        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        row.contrast = axe.violations.find((v) => v.id === 'color-contrast')?.nodes.length ?? 0;
        row.axeSerious = serious.map((v) => `${v.id} ×${v.nodes.length}`);
        const shot = info.outputPath(`${width}${route.replace(/\//g, '_')}.jpg`);
        await page.screenshot({ path: shot, fullPage: true, type: 'jpeg', quality: 60, timeout: 15_000 });
        await info.attach(`screen ${width} ${route}`, { path: shot, contentType: 'image/jpeg' });
      } catch (error) {
        row.error = String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 200);
      }
      info.annotations.push({ type: 'look', description: JSON.stringify(row) });
      rows.push(row);
    });
  }

  test.afterAll(async () => {
    await page?.context().close();
    const n = (v) => (Array.isArray(v) ? v.length : (v ?? 0));
    const lines = [
      `# Room report at ${width} px (${signedIn})`,
      '',
      `${rows.length} rooms. Contrast = axe colour-contrast nodes; overflow = px wider than the screen; codes = raw codes or keys outside support lines (in support lines); undefined = CSS variables used but never declared; off-token = colours that are not a kit token.`,
      '',
      '| Room | Contrast | Axe serious | Overflow | Overlaps | Codes | Undefined | Off-token |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map((r) =>
        r.error
          ? `| ${r.route} | not measured: ${r.error.replace(/\|/g, '/')} | | | | | | |`
          : `| ${r.route} | ${r.contrast} | ${n(r.axeSerious)} | ${r.overflowX} | ${r.overlaps} | ${n(r.codesElsewhere)} (${n(r.codesInSupportLines)}) | ${r.undefinedVars.join(' ')} | ${n(r.offTokenColours)} |`,
      ),
    ];
    const total = (k) => rows.reduce((s, r) => s + n(r[k]), 0);
    lines.push(
      '',
      `Totals: contrast ${total('contrast')}, axe serious ${total('axeSerious')}, rooms overflowing ${rows.filter((r) => r.overflowX > 0).length}, overlaps ${total('overlaps')}, codes ${total('codesElsewhere')} (${total('codesInSupportLines')} in support lines), rooms with undefined variables ${rows.filter((r) => n(r.undefinedVars) > 0).length}, not measured ${rows.filter((r) => r.error).length}.`,
    );
    const md = lines.join('\n');
    const dir = '/tmp/intafaced-real-app/results';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `look-report-${width}.md`), `${md}\n`);
    writeFileSync(join(dir, `look-report-${width}.json`), `${JSON.stringify({ width, signedIn, rows }, null, 2)}\n`);
    console.log(md);
  });
}
