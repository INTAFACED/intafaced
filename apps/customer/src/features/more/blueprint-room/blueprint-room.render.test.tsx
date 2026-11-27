import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const { query, mutate } = vi.hoisted(() => ({
  query: vi.fn(() => new Promise(() => undefined)),
  mutate: vi.fn(() => new Promise(() => undefined)),
  call(
    this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },
    record: { kind: string; module: string; path: string; output: unknown },
    input?: unknown,
    opts?: unknown,
  ) {
    // tooling/codemod/call-records: a call by its record reaches this double's own query or mutate, as the client sends it.
    return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [
      record.module,
      record.path,
      input,
      record.output,
      opts,
    ]);
  },
}));

vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../session', async (original) => {
  const real = await original<typeof import('../../session')>();
  const api = {
    query,
    mutate,
    canWrite: () => true,
    call(
      this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },
      record: { kind: string; module: string; path: string; output: unknown },
      input?: unknown,
      opts?: unknown,
    ) {
      return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [
        record.module,
        record.path,
        input,
        record.output,
        opts,
      ]);
    },
  };
  const session = { api, userId: 'a0000000-0000-4000-8000-000000000001', session: null };
  return { ...real, useSession: () => session as never, useApi: () => api as never };
});
import { BlueprintRoom } from './BlueprintRoom';

const render = () => {
  vi.stubGlobal('location', {
    pathname: '/blueprint',
    search: '',
    hash: '',
    origin: 'https://app.test',
    href: 'https://app.test/blueprint',
  });
  vi.stubGlobal('history', { length: 1, state: null });
  const html = renderToStaticMarkup(<BlueprintRoom path="/blueprint" />);
  vi.unstubAllGlobals();
  return html;
};

/** /blueprint on the kit keeps the old view's title, its switched-off session with the reason, and every control. */
it('opens under its own title on the catalogue template', () => {
  const html = render();
  expect(html).toMatch(/<h1[^>]*>Identity Blueprint<\/h1>/);
  expect(html).toContain('data-template="catalogue"');
});

it('keeps the guided session switched off with the real reason and sends nothing', () => {
  mutate.mockClear();
  const html = render();
  expect(html).toContain('Blueprint questions are not published');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Create your Blueprint<\/button>/);
  expect(html).toMatch(/<fieldset[^>]*disabled/);
  expect(html).toContain('Opt in to mentor availability');
  expect(html).not.toMatch(/Answer key|Your answer|Add answer/);
  expect(mutate).not.toHaveBeenCalled();
});

it('keeps the erasure, export and crew controls and readable choices', () => {
  const html = render();
  for (const words of ['Type ERASE BLUEPRINT', 'Review permanent erasure', 'Download your Blueprint data', 'Guided Blueprint session'])
    expect(html).toContain(words);
  expect(html).toContain('id="blueprint-crew"');
  expect(html).toMatch(/<option value="private"[^>]*>Only me<\/option>/);
  expect(html).toMatch(/<option value="portrait"[^>]*>Portrait<\/option>/);
  expect(html).not.toMatch(/class="(?!lt-|lit-)[^"]*"/);
});
