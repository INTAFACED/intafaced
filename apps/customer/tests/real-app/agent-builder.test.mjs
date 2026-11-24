import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftSaved } from './agent-builder.mjs';

// The builder's save answer on planted pages in a real Chromium, as J-agents-02 #6 met it on main in run 45279452197:
// the "Tool shapes" group still loading, its own status beside "Draft saved." in the same form. Playwright's own
// Chromium, or the machine's Chrome; with neither it says so and skips.
let browser = null;
let why = '';
beforeAll(async () => {
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  } catch (error) {
    why = String(error?.message ?? error).split('\n')[0];
  }
});
afterAll(() => browser?.close());

const LOADING = `<section role="group" aria-label="Tool shapes"><h3>Tool shapes</h3><p role="status">Loading information…</p></section>`;
const SAVED = `<p role="status">Draft saved.</p>`;

async function builderOf(inside) {
  const page = await browser.newPage();
  await page.setContent(
    `<!doctype html><html lang="en"><body><form aria-label="Agent builder">${inside}<button>Save draft</button></form></body></html>`,
  );
  return { builder: page.getByRole('form', { name: 'Agent builder' }), close: () => page.close() };
}

describe('the agent builder save answer', () => {
  it('finds "Draft saved." while the tool shapes still load, where the form\'s one status is ambiguous', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { builder, close } = await builderOf(LOADING + SAVED);
    // The fault, as the helper stood before: two statuses in the form, so the strict locator throws.
    await expect(builder.getByRole('status').textContent({ timeout: 1_000 })).rejects.toThrow(/strict mode violation/);
    expect(await draftSaved(builder).count()).toBe(1);
    await close();
  });

  it('finds nothing while the draft is unsaved, the loading status alone', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { builder, close } = await builderOf(LOADING);
    expect(await draftSaved(builder).count()).toBe(0);
    await close();
  });

  it('finds nothing for another answer in the status, such as a longer one that only starts with the words', async (t) => {
    if (!browser) return t.skip(`no Chromium to drive: ${why}`);
    const { builder, close } = await builderOf(`<p role="status">Draft saved. Publish failed.</p>`);
    expect(await draftSaved(builder).count()).toBe(0);
    await close();
  });
});
