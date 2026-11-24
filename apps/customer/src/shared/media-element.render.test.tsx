// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeepInView, useObjectUrls, usePageLeave } from './media-element';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('useObjectUrls', () => {
  it('makes one URL per item, revokes them when the list is replaced and when the room goes', () => {
    let n = 0;
    const made: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:test/${++n}`;
      made.push(url);
      return url;
    });
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const seen: string[][] = [];
    function Probe({ items }: { items: string[] }) {
      seen.push(useObjectUrls(items, (text) => new Blob([text], { type: 'text/plain' })));
      return null;
    }
    const first = ['a', 'b'];
    act(() => root.render(<Probe items={first} />));
    expect(seen[0]).toEqual([]);
    expect(seen.at(-1)).toEqual(['blob:test/1', 'blob:test/2']);
    act(() => root.render(<Probe items={first} />));
    expect(made).toHaveLength(2);
    act(() => root.render(<Probe items={['c']} />));
    expect(revoked.mock.calls.map(([url]) => url)).toEqual(['blob:test/1', 'blob:test/2']);
    expect(seen.at(-1)).toEqual(['blob:test/3']);
    act(() => root.unmount());
    expect(revoked.mock.calls.map(([url]) => url)).toEqual(['blob:test/1', 'blob:test/2', 'blob:test/3']);
    root = createRoot(host);
  });
});

describe('usePageLeave', () => {
  it('calls the latest callback when the page is hidden and once on unmount', () => {
    const calls: string[] = [];
    function Probe({ label }: { label: string }) {
      usePageLeave(() => calls.push(label));
      return null;
    }
    act(() => root.render(<Probe label="a" />));
    act(() => root.render(<Probe label="b" />));
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(calls).toEqual([]);
    state.mockReturnValue('hidden');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(calls).toEqual(['b']);
    act(() => root.unmount());
    expect(calls).toEqual(['b', 'b']);
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(calls).toEqual(['b', 'b']);
    root = createRoot(host);
  });
});

describe('useKeepInView', () => {
  it('scrolls the box to the row at the index whenever it changes', () => {
    function Probe({ index }: { index: number }) {
      const box = useRef<HTMLOListElement>(null);
      useKeepInView(box, index);
      return (
        <ol ref={box}>
          <li>one</li>
          <li>two</li>
        </ol>
      );
    }
    act(() => root.render(<Probe index={0} />));
    const list = host.querySelector('ol')!;
    const rows = list.children;
    Object.defineProperty(list, 'offsetTop', { value: 10 });
    Object.defineProperty(list, 'clientHeight', { value: 90 });
    Object.defineProperty(rows[1], 'offsetTop', { value: 100 });
    act(() => root.render(<Probe index={1} />));
    expect(list.scrollTop).toBe(60);
  });
});
