import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromeMessages } from '../../src/features/pay/portal/chrome/copy';
import { ACTION_WAITING, settledAction } from './header-action.mjs';

/**
 * A heading locator whose page draws each of `draws` in turn, one per frame, then keeps the last. Asking it for the
 * waiting words finds none, as on a page that has not drawn its heading yet: a reading that trusts their absence reads
 * the waiting state.
 */
function redrawing(...draws) {
  const page = { frame: 0, looks: 0 };
  const drawn = () => draws[Math.min(page.frame, draws.length - 1)];
  const heading = {
    querySelector: (selector) => (selector === '.pfo-action-off small' && 'off' in drawn() ? { innerText: drawn().off } : null),
    querySelectorAll: (selector) =>
      selector === 'a' && 'on' in drawn() ? drawn().on.map((href) => ({ getAttribute: (name) => (name === 'href' ? href : null) })) : [],
  };
  page.head = {
    getByText: () => ({ waitFor: async () => {} }),
    async evaluate(look, arg) {
      page.looks += 1;
      return look(heading, arg);
    },
  };
  globalThis.requestAnimationFrame = (next) => {
    page.frame += 1;
    queueMicrotask(next);
  };
  return page;
}

describe('settledAction', () => {
  let before;
  beforeEach(() => {
    before = globalThis.requestAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = before;
  });

  it('waits on the very sentence the portal draws while access loads', () => {
    expect(ACTION_WAITING).toBe(chromeMessages.headerActionWaiting);
  });

  it('reads the live action the page redraws once access loads, never the waiting state it drew first', async () => {
    const page = redrawing({ off: ACTION_WAITING }, { off: ACTION_WAITING }, { on: ['/pay/payouts/new'] });
    expect(await settledAction(page.head)).toEqual({ on: ['/pay/payouts/new'] });
    expect(page.frame).toBe(2);
  });

  it('reads the reason the page redraws once access loads, when the waiting words were not drawn yet when first asked', async () => {
    const reason = chromeMessages.moneyStepRefund;
    const page = redrawing({ off: ACTION_WAITING }, { off: reason });
    expect(await settledAction(page.head)).toEqual({ off: reason });
  });

  it('reads a switched-off action with its own reason in one look, waiting for no frame', async () => {
    const reason = chromeMessages.moneyStepRefund;
    const page = redrawing({ off: reason });
    expect(await settledAction(page.head)).toEqual({ off: reason });
    expect(page.looks).toBe(1);
    expect(page.frame).toBe(0);
  });

  it('fails on the waiting words when the action never leaves its waiting state', async () => {
    const page = redrawing({ off: ACTION_WAITING });
    await expect(settledAction(page.head, { timeout: 20 })).rejects.toThrow(ACTION_WAITING);
  });
});
