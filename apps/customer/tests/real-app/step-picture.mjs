/**
 * Readies a page for its step picture (journey.mjs `stepPicture`): from the top of the page, with no link or button focused.
 * A whole-page picture of a scrolled page draws the bar that stays at the top (and the TEST banner) over the content at the
 * scroll height, and a focused skip link shows over the page; the proof reader then reads the picture BROKEN.
 *
 * It leaves the page as it is when that would change the state the step ends on: while a menu, list box, tooltip, popover,
 * open popup or dialog that is not modal is showing (each may close on blur or on scroll); under a modal dialog it scrolls the
 * window but moves no focus, and it keeps a focused form field focused (a
 * field may check itself on blur). It scrolls only the window: a panel scrolled inside its own container keeps its place.
 * Returns what it did, for its test and the step's own annotation. Never throws: a picture never fails a test.
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
        // A menu, list box, tooltip or popover may close on blur or on scroll, so the page is left as it is. A modal dialog
        // stays open while the window scrolls behind it, so the page still goes to the top, with focus left in the dialog.
        const popup =
          [
            ...document.querySelectorAll(
              '[role="menu"], [role="listbox"], [role="tooltip"], [aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]',
            ),
          ].some(shown) || [...document.querySelectorAll('[popover]')].some(popupOpen);
        if (popup) return 'kept: something open';
        const modal = (el) => el.matches('dialog:modal, [aria-modal="true"]');
        const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')].filter(shown);
        if (dialogs.some((el) => !modal(el))) return 'kept: something open';
        const inDialog = dialogs.length > 0;
        const focused = document.activeElement;
        const field = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
        if (!inDialog && focused instanceof HTMLElement && focused !== document.body && !focused.matches(field)) focused.blur();
        const atTop = () => window.scrollX === 0 && window.scrollY === 0;
        if (atTop()) return inDialog ? 'at top, dialog kept open' : 'at top';
        // Let the page answer the scroll (a bar that changes on scroll, a frame drawn) before the picture; a page that
        // scrolls itself back (an effect that brings a section into view) is taken to the top again, up to three times.
        for (let tries = 0; tries < 3; tries += 1) {
          window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
          // Ten frames, about 160 ms: room for an effect that answers the scroll to run.
          for (let frames = 0; frames < 10; frames += 1) await new Promise((frame) => requestAnimationFrame(frame));
          if (atTop())
            return `${tries === 0 ? 'scrolled' : 'scrolled again: the page scrolled itself back'}${inDialog ? ', dialog kept open' : ''}`;
        }
        return `left at ${window.scrollY}: the page keeps scrolling itself back`;
      },
      null,
      { timeout: waitMs },
    );
    return await done.jsonValue();
  } catch {
    return 'not readied';
  }
}
