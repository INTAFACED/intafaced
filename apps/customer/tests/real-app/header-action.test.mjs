import { describe, expect, it } from 'vitest';
import { chromeMessages } from '../../src/features/pay/portal/chrome/copy';
import { ACTION_WAITING, settledAction } from './header-action.mjs';

/** A heading as the page draws it: switched off with its reason, or live links. */
function heading(drawn) {
  const small = 'off' in drawn ? { innerText: drawn.off } : null;
  const links = 'on' in drawn ? drawn.on.map((href) => ({ getAttribute: (name) => (name === 'href' ? href : null) })) : [];
  return {
    querySelector: (selector) => (selector === '.pfo-action-off small' ? small : null),
    querySelectorAll: (selector) => (selector === 'a' ? links : []),
  };
}

/**
 * A heading locator whose page draws `first`, then redraws it as `then` once access loads (never, when `then` is left
 * out): waiting for the waiting words to leave lets the redraw land, as the running app does.
 */
function redrawing(first, then) {
  const head = {
    drawn: first,
    looks: 0,
    asked: [],
    getByText(text, options) {
      head.asked.push({ text, ...options });
      return {
        async waitFor({ state, timeout }) {
          if (state !== 'detached') throw new Error(`unexpected state ${state}`);
          if (head.drawn.off !== text) return;
          if (!then) throw Object.assign(new Error(`waitFor: Timeout ${timeout}ms exceeded.`), { name: 'TimeoutError' });
          head.drawn = then;
        },
      };
    },
    async evaluate(read) {
      head.looks += 1;
      return read(heading(head.drawn));
    },
  };
  return head;
}

describe('settledAction', () => {
  it('waits on the very sentence the portal draws while access loads', () => {
    expect(ACTION_WAITING).toBe(chromeMessages.headerActionWaiting);
  });

  it('reads the live action the page redraws once access loads, in one look, never the reason it no longer draws', async () => {
    const head = redrawing({ off: ACTION_WAITING }, { on: ['/pay/payouts/new'] });
    expect(await settledAction(head)).toEqual({ on: ['/pay/payouts/new'] });
    expect(head.asked).toEqual([{ text: ACTION_WAITING, exact: true }]);
    expect(head.looks).toBe(1);
  });

  it('reads a switched-off action with its own reason at once', async () => {
    const reason = chromeMessages.moneyStepRefund;
    const head = redrawing({ off: reason });
    expect(await settledAction(head)).toEqual({ off: reason });
    expect(head.looks).toBe(1);
  });

  it('fails on the waiting words when the action never leaves its waiting state, and reads nothing', async () => {
    const head = redrawing({ off: ACTION_WAITING });
    await expect(settledAction(head, { timeout: 20 })).rejects.toThrow('waitFor: Timeout 20ms exceeded.');
    expect(head.looks).toBe(0);
  });
});
