// A business room's header action in the running app, read once the page has finished drawing it.

/** The action's reason while the person's access loads (`headerActionWaiting`, `src/features/pay/portal/chrome/copy.ts`). */
export const ACTION_WAITING = 'Available once your account details load.';

/**
 * One look at the heading: the action switched off with its reason, or the live links and where they go. A look that
 * finds the action still waiting looks again on the page's next frame, so a page redrawing it is never asked twice in
 * one frame. Runs in the page, so it names everything it uses itself.
 */
async function drawnAction(heading, waiting) {
  const read = () => {
    const off = heading.querySelector('.pfo-action-off small');
    return off ? { off: off.innerText } : { on: [...heading.querySelectorAll('a')].map((a) => a.getAttribute('href')) };
  };
  const first = read();
  if (first.off !== waiting) return first;
  await new Promise((frame) => requestAnimationFrame(() => frame()));
  return read();
}

/**
 * The room's header action as drawn (`head` is the heading's locator), once it has left its waiting state. While the
 * person's access loads, the action is drawn off with the waiting reason and then redrawn, live or off with its own
 * reason. Each reading is one look at the page, so a redraw between two questions about it can't leave a question
 * waiting on an element that is gone. The heading is looked at until a look shows it settled: waiting for the waiting
 * words to leave would pass at once on a page that has not drawn them yet. An action still waiting after `timeout`
 * fails on the waiting words.
 */
export async function settledAction(head, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const drawn = await head.evaluate(drawnAction, ACTION_WAITING);
    if (drawn.off !== ACTION_WAITING) return drawn;
    if (Date.now() >= deadline) throw new Error(`header action still drawn "${ACTION_WAITING}" after ${timeout}ms`);
  }
}
