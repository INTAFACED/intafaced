// Toast: a polite live region that is in the page before any toast arrives, and a hook that refuses to work without it.
// Raising, closing and the timer run in a page: apps/customer/src/app/kit/volt-kit.render.test.tsx.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToastProvider, useToast } from './toast.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

function Raises() {
  const toast = useToast();
  return <button type="button">{typeof toast.add}</button>;
}

describe('Toast', () => {
  it('draws its polite live region, empty, after the room, so the first toast is announced too', () => {
    const out = html(
      <ToastProvider closeLabel="Dismiss">
        <main>Room</main>
      </ToastProvider>,
    );
    expect(out).toBe('<main>Room</main><div class="lit-toasts" role="status" aria-live="polite" data-slot="toast-region"></div>');
  });

  it('hands its parts a way to raise one', () => {
    expect(
      html(
        <ToastProvider closeLabel="Dismiss">
          <Raises />
        </ToastProvider>,
      ),
    ).toContain('<button type="button">function</button>');
  });

  it('refuses to be used without a provider, naming the fix', () => {
    expect(() => html(<Raises />)).toThrow(/needs a ToastProvider/);
  });
});
