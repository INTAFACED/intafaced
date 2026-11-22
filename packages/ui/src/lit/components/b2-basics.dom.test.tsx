// @vitest-environment happy-dom
/**
 * The kit parts' keyboard and caret behaviour, drawn in a document: what server markup can't show.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DecimalInput, Tabs, isRightToLeft, nextTabIndex } from './b2-basics.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function draw(el: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const ITEMS = [
  { label: 'Book', value: 'book' },
  { label: 'Trades', value: 'trades' },
  { label: 'Info', value: 'info' },
];

function TabRow({ dir }: { dir?: 'rtl' | 'ltr' }) {
  const [value, setValue] = React.useState('trades');
  return (
    <div dir={dir}>
      <Tabs id="t" label="Panels" items={ITEMS} value={value} onChange={setValue} />
    </div>
  );
}

const press = (el: Element, key: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
const shown = (page: HTMLElement) => page.querySelector('[role="tab"][aria-selected="true"]')?.textContent;

describe('Tabs on a right-to-left page', () => {
  it('ArrowLeft moves to the next tab and ArrowRight to the one before, mirrored as the row reads', () => {
    const page = draw(<TabRow dir="rtl" />);
    press(page.querySelector('[aria-selected="true"]')!, 'ArrowLeft');
    expect(shown(page)).toBe('Info');
    expect(document.activeElement?.textContent).toBe('Info');
    press(page.querySelector('[aria-selected="true"]')!, 'ArrowRight');
    press(page.querySelector('[aria-selected="true"]')!, 'ArrowRight');
    expect(shown(page)).toBe('Book');
  });

  it('keeps ArrowRight as next on a left-to-right page, and Home, End, up and down as they were', () => {
    const page = draw(<TabRow />);
    press(page.querySelector('[aria-selected="true"]')!, 'ArrowRight');
    expect(shown(page)).toBe('Info');
    press(page.querySelector('[aria-selected="true"]')!, 'Home');
    expect(shown(page)).toBe('Book');
    expect(nextTabIndex(0, 'ArrowDown', 3, true)).toBe(1);
    expect(nextTabIndex(0, 'End', 3, true)).toBe(2);
  });

  it('reads the nearest dir: a left-to-right island inside a right-to-left page is left to right', () => {
    const page = draw(
      <div dir="rtl">
        <span dir="ltr">
          <b id="in-ltr" />
        </span>
        <b id="in-rtl" />
      </div>,
    );
    expect(isRightToLeft(page.querySelector('#in-ltr')!)).toBe(false);
    expect(isRightToLeft(page.querySelector('#in-rtl')!)).toBe(true);
  });
});

function Amount({ initial = '12.5', precision = 2 }: { initial?: string; precision?: number }) {
  const [value, setValue] = React.useState(initial);
  return <DecimalInput aria-label="Amount" value={value} onValueChange={setValue} precision={precision} />;
}

/** Types `text` at the caret as a browser does: the box's text changes, the caret sits after it, an input event fires. */
async function typeAt(box: HTMLInputElement, at: number, text: string) {
  box.focus();
  const raw = box.value.slice(0, at) + text + box.value.slice(at);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(box, raw);
    box.setSelectionRange(at + text.length, at + text.length);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('DecimalInput when it refuses a keystroke', () => {
  it('keeps the text and puts the caret back where the person was typing, not at the end', async () => {
    const page = draw(<Amount />);
    const box = page.querySelector('input')!;
    await typeAt(box, 1, 'a');
    expect(box.value).toBe('12.5');
    expect(box.selectionStart).toBe(1);
    expect(box.selectionEnd).toBe(1);
  });

  it('a second point is refused in place too', async () => {
    const page = draw(<Amount initial="1.25" />);
    const box = page.querySelector('input')!;
    await typeAt(box, 2, '.');
    expect(box.value).toBe('1.25');
    expect(box.selectionStart).toBe(2);
  });

  it('a keystroke it takes moves the caret on by one, where it was typed', async () => {
    const page = draw(<Amount />);
    const box = page.querySelector('input')!;
    await typeAt(box, 1, '7');
    expect(box.value).toBe('172.5');
    expect(box.selectionStart).toBe(2);
  });
});
