// One Chromium for the unit tests that read planted pages in a real browser (step-picture, agent-builder): Playwright's
// own, or the machine's Chrome; with neither, `why` says so and the tests skip. A cold launch on a CI runner has taken
// over vitest’s default 10 s hook timeout, so the hook that launches it gets its own budget.
export const BROWSER_HOOK_TIMEOUT = 60_000;

/** Launches the browser; resolves to `{ browser, why }`, `browser` null and `why` the first line of the error when none starts. */
export async function launchTestBrowser() {
  try {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
    return { browser, why: '' };
  } catch (error) {
    return { browser: null, why: String(error?.message ?? error).split('\n')[0] };
  }
}
