// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TEST data only: what identity's trading-checks doors answer, and what the page sent (J-cex-spot-01 #3).
const USER = '12345678-1234-4234-8234-123456789abc';
const world = vi.hoisted(() => ({
  read: null as unknown,
  run: null as unknown,
  sent: [] as Array<{ procedure: string; input: unknown }>,
}));
vi.mock('../session/session', async (original) => ({
  ...(await original<typeof import('../session/session')>()),
  useSession: () => ({
    userId: USER,
    api: {
      query: () => Promise.resolve(world.read),
      mutate: (_module: string, procedure: string, input: unknown) => {
        world.sent.push({ procedure, input });
        return Promise.resolve(world.run);
      },
    },
  }),
}));

import { VerificationTradingChecks } from './VerificationTradingChecks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
let done = 0;
const tick = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function open() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<VerificationTradingChecks disabled={false} onDone={() => done++} />));
  await tick();
}
const BANNED = /selfie|passport|ID document|driving licen[cs]e|identity card/i;
const SCREENING = /screen|sanction|watch ?list|list match/i;
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function fillAndRun() {
  const form = host.querySelector('form')!;
  type(form.querySelector('input[name="trading-legal-name"]')!, 'TEST Trader');
  await tick();
  await act(async () => form.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(async () => form.querySelector<HTMLButtonElement>('button[type=submit]')!.click());
  await tick();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  done = 0;
  world.sent = [];
  world.read = { ok: true, data: { state: 'not_run', country: 'DE', listSet: true } };
  world.run = { ok: true, data: { state: 'cleared' } };
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('the trading checks on /verification', () => {
  it('asks for the legal name and the country confirmed, pre-filled from sign-up; nothing else', async () => {
    await open();
    const form = host.querySelector('form')!;
    expect(form.getAttribute('aria-label')).toBe('Trading checks');
    expect(form.querySelector<HTMLSelectElement>('select')!.value).toBe('DE');
    expect(form.textContent).toContain('I live in Germany');
    expect(form.querySelector('button[type=submit]')!.textContent).toBe('Run the checks');
    expect(host.querySelectorAll('input[type=file], iframe')).toHaveLength(0);
    expect(host.textContent).not.toMatch(BANNED);
  });

  it('sends the name, the country and the confirmation to identity, then reads the page again', async () => {
    await open();
    await fillAndRun();
    expect(world.sent).toEqual([
      { procedure: 'kyc.tradingChecks.run', input: { legalName: 'TEST Trader', country: 'DE', confirmed: true } },
    ]);
    expect(done).toBe(1);
  });

  it('a blank owner list shows its typed refusal, and nothing reads as cleared', async () => {
    world.run = { ok: false, reason: 'error', message: 'paused', code: 'kyc.screening_list_unset', status: 412 };
    await open();
    await fillAndRun();
    const refused = host.querySelector('[data-code="kyc.screening_list_unset"]')!;
    expect(refused.textContent).toContain('nothing was checked or changed');
    expect(done).toBe(0);
  });

  it('a held account reads a neutral "under review" that never says why', async () => {
    world.read = { ok: true, data: { state: 'held', country: 'DE', listSet: true } };
    await open();
    expect(host.textContent).toMatch(/under review/i);
    expect(host.textContent).not.toMatch(SCREENING);
    expect(host.querySelector('form')).toBeNull();
  });
});
