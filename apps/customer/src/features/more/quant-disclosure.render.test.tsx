// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

const world = vi.hoisted(() => ({ read: undefined as unknown as () => Promise<unknown>, calls: [] as unknown[][] }));
vi.mock('../session/session', () => ({
  useApi: () => ({
    query: (...args: unknown[]) => {
      world.calls.push(args);
      return world.read();
    },
  }),
}));

import { authoredRefusal } from '../../shared/api';
import { QuantDisclosure } from './QuantDisclosure';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.calls = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});
async function show() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<QuantDisclosure />));
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}

describe('quant risk disclosure panel', () => {
  it('reads the current disclosure from the quant service', async () => {
    world.read = async () => ({ ok: true, data: { published: false } });
    await show();
    expect(world.calls[0]?.slice(0, 2)).toEqual(['quant', 'disclosure.current']);
  });

  it('says none is published and invents no wording', async () => {
    world.read = async () => ({ ok: true, data: { published: false } });
    await show();
    const text = document.body.textContent ?? '';
    expect(text).toContain('No risk disclosure is published, so none can be accepted.');
    expect(document.body.querySelector('[data-testid="quant-disclosure-text"]')).toBeNull();
    expect(text).toContain('Every result in Quant is simulated.');
  });

  it('shows the published wording and its version exactly as published', async () => {
    world.read = async () => ({
      ok: true,
      data: { published: true, version: 3, text: 'Line one.\nLine two.', publishedAt: '2026-10-20T12:00:00.000Z' },
    });
    await show();
    expect(document.body.querySelector('[data-testid="quant-disclosure-text"]')?.textContent).toBe('Line one.\nLine two.');
    expect(document.body.textContent).toContain('Version 3');
    expect(document.body.textContent).not.toContain('No risk disclosure is published');
  });

  it('keeps the accept control on the page, off, with the reason beside it', async () => {
    world.read = async () => ({ ok: true, data: { published: false } });
    await show();
    const button = document.body.querySelector('[data-testid="quant-disclosure-accept"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('quant-disclosure-accept-reason');
    expect(document.getElementById('quant-disclosure-accept-reason')?.textContent).toContain(
      'It is taken at the step that puts a saved version to use',
    );
  });

  it('says the read failed and offers a retry, never the wording of an older read', async () => {
    world.read = async () => authoredRefusal('error', { key: 'loadFailed' });
    await show();
    expect(document.body.textContent).toContain('The risk disclosure could not be read.');
    expect(document.body.querySelector('[data-testid="quant-disclosure-text"]')).toBeNull();
  });

  it('shows a loading state while the read is out', async () => {
    world.read = () => new Promise(() => undefined);
    await show();
    expect(document.body.textContent).toContain('Reading the risk disclosure');
  });
});
