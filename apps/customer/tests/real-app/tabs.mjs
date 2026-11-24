// Tabs in the running app, chosen so a click the page drops is not lost.

/**
 * Chooses the tab named `name` inside `scope` and returns it once it reads selected. A click can land while a dialog is
 * still opening and be dropped: J-copy-bots-otc-12 #1 in run 43781336614 clicked "Skipped" in the follow dialog and the
 * page still showed "Copied orders" selected, so the skip it was looking for never drew. The tab is clicked again until
 * it reads selected; a tab that never does fails here, by name, not as missing text later.
 */
export async function chooseTab(scope, name, { timeout = 30_000, settle = 2_000 } = {}) {
  const tab = scope.getByRole('tab', { name, exact: true });
  const chosen = scope.getByRole('tab', { name, exact: true, selected: true });
  const until = Date.now() + timeout;
  for (;;) {
    await tab.click();
    try {
      await chosen.waitFor({ timeout: Math.max(1, Math.min(settle, until - Date.now())) });
      return tab;
    } catch (error) {
      if (error?.name !== 'TimeoutError') throw error;
      if (Date.now() >= until) throw new Error(`the tab "${name}" never read selected within ${timeout} ms of clicking it`);
    }
  }
}
