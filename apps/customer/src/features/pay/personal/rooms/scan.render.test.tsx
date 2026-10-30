// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
vi.mock('../../../session/session', () => ({
  useSession: () => ({
    userId: 'u1',
    session: { accessToken: 'x', expiresAt: '2099-01-01T00:00:00Z', userId: 'u1' },
    api: {},
  }),
}));

// The browser's own code reader, answering whatever the test puts in `seen`. TEST data only.
const seen = vi.hoisted(() => ({ text: '' }));
vi.hoisted(() => {
  class FakeDetector {
    static getSupportedFormats = async () => ['qr_code'];
    async detect() {
      return seen.text ? [{ rawValue: seen.text }] : [];
    }
  }
  (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = FakeDetector;
});

import { PersonalRoom } from './PersonalRoom';
import { personalRoomFor } from './rooms';
import { cameraRefusal, IMAGE_MAX_BYTES, payTarget, ScanError } from '../scan';

const CODE = `v1.0b7a3c1e-4d2f-4a8b-9c6d-1e2f3a4b5c6d.AbCdEfGhIjKlMnOp.${'A'.repeat(43)}`;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | null = null;
const getUserMedia = vi.fn();
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  seen.text = '';
  history.replaceState(null, '', '/pay/scan');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ width: 40, height: 40, close() {} });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  getUserMedia.mockReset();
});
async function openScan() {
  root = createRoot(host);
  const mounted = root;
  await act(async () => mounted.render(<PersonalRoom match={personalRoomFor('/pay/scan')!} />));
}
async function choose(file: File) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const refused = () => host.querySelector('[data-kind="refused"]');
const image = (bytes = 8) => new File([new Uint8Array(bytes)], 'code.png', { type: 'image/png' });

describe('scan to pay: what a code opens', () => {
  it("opens Send on this app's own pay link and on nothing else", () => {
    const origin = 'https://app.example';
    expect(payTarget(`${origin}/pay/send?to=%40ada&qr=${CODE}`, origin)).toBe(`/pay/send?to=ada&qr=${CODE}`);
    for (const text of [
      'https://elsewhere.example/pay/send?to=%40ada',
      `${origin}/pay/receive`,
      '/pay/send?to=%40ada',
      'pay/send?to=%40ada',
      'hello',
      '',
    ]) {
      expect(() => payTarget(text, origin), text).toThrow(ScanError);
    }
  });

  it('tells a denied camera from a missing one', () => {
    expect(cameraRefusal(new DOMException('no', 'NotAllowedError'))).toBe('scan.camera_denied');
    expect(cameraRefusal(new DOMException('no', 'SecurityError'))).toBe('scan.camera_denied');
    expect(cameraRefusal(new DOMException('none', 'NotFoundError'))).toBe('scan.camera_unavailable');
    expect(cameraRefusal('anything')).toBe('scan.camera_unavailable');
  });
});

describe('scan to pay: the room', () => {
  it('opens Send with the payee from an uploaded image of a pay code', async () => {
    await openScan();
    seen.text = `${location.origin}/pay/send?to=%40ada&qr=${CODE}`;
    await choose(image());
    expect(location.pathname + location.search).toBe(`/pay/send?to=ada&qr=${CODE}`);
    expect(refused()).toBeNull();
  });

  it('reads a photo the browser gave no type', async () => {
    await openScan();
    seen.text = `${location.origin}/pay/send?to=%40ada`;
    await choose(new File([new Uint8Array(8)], 'photo', { type: '' }));
    expect(location.pathname + location.search).toBe('/pay/send?to=ada');
  });

  it.each([
    ['a file that is not an image', () => new File(['x'], 'code.txt', { type: 'text/plain' }), '', 'scan.not_image'],
    ['an image over the size cap', () => image(IMAGE_MAX_BYTES + 1), '', 'scan.image_too_large'],
    ['an image with no code in it', () => image(), '', 'scan.unreadable'],
    ['a code that is not a pay code', () => image(), 'https://elsewhere.example/pay/send?to=%40ada', 'scan.not_pay_code'],
  ])('refuses %s with its code and opens nothing', async (_name, file, text, code) => {
    await openScan();
    seen.text = text;
    await choose(file());
    expect(location.pathname).toBe('/pay/scan');
    expect(refused()?.textContent).toContain(code);
    expect(refused()?.textContent).toContain('Nothing was opened');
  });

  it('refuses a denied camera and keeps the image upload on', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await openScan();
    const camera = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Scan with the camera'))!;
    await act(async () => {
      camera.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'environment' }, audio: false });
    expect(refused()?.textContent).toContain('scan.camera_denied');
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false);
    expect(host.querySelector('video')).toBeNull();
  });

  it('keeps the blocker for shop codes on screen', async () => {
    await openScan();
    const reason = host.querySelector('[data-testid="pay-reason"]');
    expect(reason?.getAttribute('data-slice')).toBe('PP-send-request-11');
    expect(reason?.textContent).toMatch(/shop or in-store code is not read here/i);
  });
});
