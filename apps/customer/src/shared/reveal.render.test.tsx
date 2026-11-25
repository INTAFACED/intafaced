// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReveal } from './reveal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const scrolled = vi.fn();

beforeEach(() => {
  scrolled.mockReset();
  Element.prototype.scrollIntoView = scrolled;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Line({ news, onMount, other }: { news: string; onMount?: boolean; other?: number }) {
  const reveal = useReveal<HTMLParagraphElement>(news, { onMount });
  return (
    <p ref={reveal} data-other={other}>
      {news}
    </p>
  );
}

describe('useReveal', () => {
  it('brings an outcome into view when it appears and on each new state, never on a render that changes nothing', () => {
    act(() => root.render(<Line news="working" onMount />));
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' });
    // A poll's re-render with the same news leaves the person's scroll alone.
    act(() => root.render(<Line news="working" onMount other={1} />));
    expect(scrolled).toHaveBeenCalledTimes(1);
    act(() => root.render(<Line news="set" onMount other={2} />));
    expect(scrolled).toHaveBeenCalledTimes(2);
  });

  it('leaves a list item where it is when the dialog opens, and brings it into view when what became of it changes', () => {
    act(() => root.render(<Line news="armed" />));
    expect(scrolled).not.toHaveBeenCalled();
    act(() => root.render(<Line news="armed" other={1} />));
    expect(scrolled).not.toHaveBeenCalled();
    act(() => root.render(<Line news="failed" />));
    expect(scrolled).toHaveBeenCalledTimes(1);
  });
});
