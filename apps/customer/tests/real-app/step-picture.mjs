/**
 * Readies a page for its step picture (journey.mjs `stepPicture`): from the top of the page, with no link or button focused.
 * A whole-page picture of a scrolled page draws the bar that stays at the top (and the TEST banner) over the content at the
 * scroll height, and a focused skip link shows over the page; the proof reader then reads the picture BROKEN.
 *
 * It leaves the page as it is when that would change the state the step ends on: while a dialog, menu, list box, tooltip,
 * popover or open popup is showing (each may close on blur or on scroll), and it keeps a focused form field focused (a
 * field may check itself on blur). It scrolls only the window: a panel scrolled inside its own container keeps its place.
 * Returns what it did, for its test. Never throws: a picture never fails a test.
 */
export async function fromTop(page, waitMs = 5000) {
  try {
    // waitForFunction, not evaluate, for its timeout: a call held by an open browser dialog (alert, confirm) gives up after
    // waitMs, and the picture is taken as the page stands.
    const done = await page.waitForFunction(
      async () => {
        const shown = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
        const popupOpen = (el) => {
          try {
            return el.matches(':popover-open');
          } catch {
            return false;
          }
        };
        const open =
          [
            ...document.querySelectorAll(
              'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]',
            ),
          ].some(shown) || [...document.querySelectorAll('[popover]')].some(popupOpen);
        if (open) return 'kept: something open';
        const focused = document.activeElement;
        const field = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
        if (focused instanceof HTMLElement && focused !== document.body && !focused.matches(field)) focused.blur();
        if (window.scrollX === 0 && window.scrollY === 0) return 'at top';
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        // Let the page answer the scroll (a bar that changes on scroll, a frame drawn) before the picture.
        await new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame)));
        return 'scrolled';
      },
      null,
      { timeout: waitMs },
    );
    return await done.jsonValue();
  } catch {
    return 'not readied';
  }
}
