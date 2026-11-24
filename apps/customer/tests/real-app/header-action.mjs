// A business room's header action in the running app, read once the page has finished drawing it.

/** The action's reason while the person's access loads (`headerActionWaiting`, `src/features/pay/portal/chrome/copy.ts`). */
export const ACTION_WAITING = 'Available once your account details load.';

/** One look at the heading: the action switched off with its reason, or the live links and where they go. */
function drawnAction(heading) {
  const off = heading.querySelector('.pfo-action-off small');
  return off ? { off: off.innerText } : { on: [...heading.querySelectorAll('a')].map((a) => a.getAttribute('href')) };
}

/**
 * The room's header action as drawn (`head` is the heading's locator), once it has left its waiting state. While the
 * person's access loads, the action is drawn off with the waiting reason and then redrawn, live or off with its own
 * reason. The reading is one look at the page, so a redraw between two questions about it can't leave a question
 * waiting on an element that is gone; an action still waiting after `timeout` fails on the waiting words.
 */
export async function settledAction(head, { timeout = 30_000 } = {}) {
  await head.getByText(ACTION_WAITING, { exact: true }).waitFor({ state: 'detached', timeout });
  return head.evaluate(drawnAction);
}
