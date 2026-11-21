// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A Preview room is public, so it renders while the boot refresh is still restoring the sign-in. An engine action sent
// then carries no token and is refused 401 instead of the typed Preview refusal, so every
// engine button waits for the restore.
const session = vi.hoisted(() => ({ restoring: true, calls: [] as unknown[] }));
vi.mock('../session/session', () => ({
  useSession: () => ({ restoring: session.restoring }),
  useApi: () => ({
    mutate: async (...args: unknown[]) => {
      session.calls.push(args);
      return { ok: false, message: 'preview.engine_not_built — quant.tick_engine:start', code: 'preview.engine_not_built' };
    },
  }),
}));
vi.mock('./QuantRooms', () => ({ QuantRooms: () => null }));

const { EditorRoom, TesterRoom, OptimiseRoom } = await import('./PreviewRooms');

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  session.calls = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const engineButtons: Record<string, string[]> = {
  editor: ['Compile', 'Debug'],
  tester: ['Start'],
  optimise: ['Start', 'Stop', 'Resume', 'Export'],
};
const rooms = { editor: EditorRoom, tester: TesterRoom, optimise: OptimiseRoom };

function button(name: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name} in ${[...host.querySelectorAll('button')].map((b) => b.textContent).join(', ')}`);
  return found;
}

describe('Preview rooms while the sign-in is restoring', () => {
  for (const [id, Room] of Object.entries(rooms)) {
    it(`${id}: every engine button is disabled and sends nothing until the restore answers`, async () => {
      session.restoring = true;
      act(() => root.render(<Room paper={false} />));
      // The optimiser's Stop, Resume and Export sit in the walk-forward section, which opens locally.
      if (id === 'optimise') act(() => button('Walk-forward').click());
      for (const name of engineButtons[id]!) {
        const b = button(name);
        expect(b.disabled, `${name} waits`).toBe(true);
        await act(async () => b.click());
      }
      expect(session.calls).toEqual([]);

      session.restoring = false;
      act(() => root.render(<Room paper={false} />));
      for (const name of engineButtons[id]!) expect(button(name).disabled, `${name} is live`).toBe(false);
      await act(async () => button(engineButtons[id]![0]!).click());
      expect(session.calls).toHaveLength(1);
    });
  }
});
