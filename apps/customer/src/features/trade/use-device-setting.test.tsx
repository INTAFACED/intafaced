// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDeviceSetting } from './hooks';

/**
 * Unit card — useDeviceSetting keys
 *
 * 1. Promise: a setting is kept per key. When the key changes (another user, another market), the value shown and written
 *    is the new key's own, and the old key's value is never copied under the new one.
 * 2. Break: the state was created once, so a key change kept the old value and the effect wrote it under the new key.
 * 3. Done bar: after a key change the new key reads its own stored value (or the initial), and the old key keeps its value.
 */
const isNumber = (v: unknown): v is number => typeof v === 'number';

let root: Root;
let host: HTMLDivElement;
let shown: number | null = null;
let setter: ((next: number) => void) | null = null;

function Probe({ storageKey }: { storageKey: string }) {
  const [value, set] = useDeviceSetting<number>(storageKey, 0, isNumber);
  shown = value;
  setter = set;
  return null;
}

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('useDeviceSetting: a key change reads the new key', () => {
  it('a changed key shows its own stored value and never writes the old value under the new key', async () => {
    await act(async () => root.render(<Probe storageKey="charts:user-a" />));
    await act(async () => setter?.(7));
    expect(localStorage.getItem('charts:user-a')).toBe('7');

    await act(async () => root.render(<Probe storageKey="charts:user-b" />));
    expect(shown).toBe(0);
    expect(localStorage.getItem('charts:user-b')).toBe('0');
    expect(localStorage.getItem('charts:user-a')).toBe('7');
  });

  it('a changed key reads the value that was stored under it', async () => {
    localStorage.setItem('charts:user-c', '3');
    await act(async () => root.render(<Probe storageKey="charts:user-a" />));
    await act(async () => setter?.(7));
    await act(async () => root.render(<Probe storageKey="charts:user-c" />));
    expect(shown).toBe(3);
    expect(localStorage.getItem('charts:user-a')).toBe('7');
  });
});
