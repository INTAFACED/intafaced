// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBodyData, useCommittedRef, useEventListener, useFocusOnChange, useInterval, useTimeout } from './use-outside';
import { useKeptDraft } from './use-kept-draft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  sessionStorage.clear();
});

describe('timers', () => {
  it('runs the latest interval callback and stops on null; a timeout fires once', () => {
    const seen: string[] = [];
    function Probe({ label, ms }: { label: string; ms: number | null }) {
      useInterval(() => seen.push(label), ms);
      useTimeout(() => seen.push(`once:${label}`), ms === null ? null : 1500);
      return null;
    }
    act(() => root.render(<Probe label="a" ms={1000} />));
    act(() => vi.advanceTimersByTime(1000));
    act(() => root.render(<Probe label="b" ms={1000} />));
    act(() => vi.advanceTimersByTime(1000));
    act(() => root.render(<Probe label="c" ms={null} />));
    act(() => vi.advanceTimersByTime(5000));
    expect(seen).toEqual(['a', 'once:b', 'b']);
  });
});

describe('listeners and refs', () => {
  it('listens with the latest handler until unmount, and writes the committed value into a ref', () => {
    const heard: string[] = [];
    const ref = { current: '' };
    function Probe({ label }: { label: string }) {
      useEventListener(window, 'focus', () => heard.push(label));
      useCommittedRef(ref, label);
      return null;
    }
    act(() => root.render(<Probe label="a" />));
    expect(ref.current).toBe('a');
    act(() => root.render(<Probe label="b" />));
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(heard).toEqual(['b']);
    expect(ref.current).toBe('b');
    act(() => root.unmount());
    act(() => void window.dispatchEvent(new Event('focus')));
    expect(heard).toEqual(['b']);
    root = createRoot(host);
  });

  it('focuses on mount and again when the key changes', () => {
    function Probe({ prompt }: { prompt: string }) {
      const button = useRef<HTMLButtonElement>(null);
      useFocusOnChange(button, prompt);
      return (
        <>
          <button ref={button}>keep</button>
          <input />
        </>
      );
    }
    act(() => root.render(<Probe prompt="one" />));
    expect(document.activeElement?.textContent).toBe('keep');
    act(() => host.querySelector('input')!.focus());
    act(() => root.render(<Probe prompt="one" />));
    expect(document.activeElement?.tagName).toBe('INPUT');
    act(() => root.render(<Probe prompt="two" />));
    expect(document.activeElement?.textContent).toBe('keep');
  });

  it('marks the body while mounted and drops an undefined mark', () => {
    function Probe({ open }: { open: boolean }) {
      useBodyData({ crmView: 'enquiries', crmDetail: open ? 'open' : undefined });
      return null;
    }
    act(() => root.render(<Probe open />));
    expect(document.body.dataset).toMatchObject({ crmView: 'enquiries', crmDetail: 'open' });
    act(() => root.render(<Probe open={false} />));
    expect(document.body.dataset.crmDetail).toBeUndefined();
    act(() => root.unmount());
    expect(document.body.dataset.crmView).toBeUndefined();
    root = createRoot(host);
  });
});

describe('useKeptDraft', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('writes the draft, waits while paused, and clears it once nothing is left to keep', () => {
    function Probe({ note, paused }: { note: string | null; paused: boolean }) {
      useKeptDraft({ enquiryId: id, userId: 'founder', revision: 3, fields: note === null ? null : { note } }, paused, {
        record: null,
        base: null,
      });
      return null;
    }
    act(() => root.render(<Probe note="hello" paused={false} />));
    const stored = () => Object.keys(sessionStorage).filter((key) => sessionStorage.getItem(key)?.includes(id));
    expect(stored().length).toBeGreaterThan(0);
    act(() => root.render(<Probe note={null} paused />));
    expect(stored().length).toBeGreaterThan(0);
    act(() => root.render(<Probe note={null} paused={false} />));
    expect(stored()).toEqual([]);
  });
});
