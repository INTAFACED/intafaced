// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { LitLookRoot } from './LitLookRoot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  localStorage.clear();
});

function mount() {
  host = document.createElement('div');
  host.innerHTML = '<header data-obscures="top"></header><nav data-obscures="bottom"></nav>';
  document.body.append(host);
  root = createRoot(host.appendChild(document.createElement('div')));
  act(() => root!.render(<LitLookRoot />));
}

describe('the Lit glass access hooks at the app root', () => {
  it('keeps data-surfaces on the root and the bar insets measured while mounted, and takes both off after', () => {
    mount();
    const html = document.documentElement;
    expect(html.getAttribute('data-surfaces')).toBe('glass');
    expect(html.style.getPropertyValue('--a11y-obscured-top')).toMatch(/px$/);
    expect(html.style.getPropertyValue('--a11y-obscured-bottom')).toMatch(/px$/);

    act(() => root!.unmount());
    root = null;
    expect(html.hasAttribute('data-surfaces')).toBe(false);
    expect(html.style.getPropertyValue('--a11y-obscured-top')).toBe('');
    expect(html.style.getPropertyValue('--a11y-obscured-bottom')).toBe('');
  });

  it('turns solid when the person chose Solid surfaces on this device', () => {
    localStorage.setItem('intafaced.surfaces', 'solid');
    mount();
    expect(document.documentElement.getAttribute('data-surfaces')).toBe('solid');
  });
});
