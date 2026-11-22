// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { Sheet } from '@intafaced/ui/lit/templates';

/** The kit Sheet gives focus back to the control that opened it, as the old Dialog did (/verification's review). */
describe('kit Sheet focus', () => {
  it('returns focus to the opener when the sheet goes away', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const opener = document.createElement('button');
    opener.textContent = 'Review request';
    document.body.append(opener);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    opener.focus();
    await act(async () =>
      root.render(
        <Sheet open title="Review" onClose={() => {}}>
          <button type="button">Submit</button>
        </Sheet>,
      ),
    );
    host.querySelector<HTMLButtonElement>('dialog button')!.focus();
    expect(document.activeElement).not.toBe(opener);
    await act(async () => root.render(<></>));
    expect(document.activeElement).toBe(opener);
    root.unmount();
  });
});
