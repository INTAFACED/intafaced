// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentPreferences, savePreferences } from '../../shared/preferences';
import { TradingSettings } from './TradingSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  savePreferences({ resetSizeOnSubmit: true, quickSizes: [] });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
async function show() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<TradingSettings />));
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = (form: HTMLFormElement) =>
  act(async () => void form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

describe('Trading settings', () => {
  it('keeps the order summary on and says why, and shows the share row as not available', async () => {
    await show();
    const [summary] = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(summary!.checked).toBe(true);
    expect(summary!.disabled).toBe(true);
    expect(host.textContent).toContain('Market orders always show it.');
    expect(host.textContent).toContain('Not available. A shared order needs a share window, and none is set');
  });

  it('stores the clear-amount choice', async () => {
    await show();
    const box = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
    expect(box.checked).toBe(true);
    await act(async () => box.click());
    expect(currentPreferences().resetSizeOnSubmit).toBe(false);
  });

  it('saves a valid quick-size list, and refuses a bad one without changing what is stored', async () => {
    await show();
    const input = host.querySelector<HTMLInputElement>('form input')!;
    const form = host.querySelector('form')!;
    await type(input, '0.1, 0.5, 1');
    await submit(form);
    expect(currentPreferences().quickSizes).toEqual(['0.1', '0.5', '1']);
    expect(host.textContent).toContain('Quick sizes saved.');
    await type(input, '0.1, abc');
    await submit(form);
    expect(currentPreferences().quickSizes).toEqual(['0.1', '0.5', '1']);
    expect(host.textContent).toContain('Enter positive decimal amounts');
    await type(input, '');
    await submit(form);
    expect(currentPreferences().quickSizes).toEqual([]);
  });

  it('reads a bad stored list as blank instead of dropping the other preferences', () => {
    savePreferences({ upColor: 'red' });
    expect(() => savePreferences({ quickSizes: ['x'] as unknown as string[] })).not.toThrow();
    expect(currentPreferences().quickSizes).toEqual([]);
    expect(currentPreferences().upColor).toBe('red');
    savePreferences({ upColor: 'green' });
  });
});
