import jsQR from 'jsqr';
import { parseRequestLink, requestPath } from './personal-model';

/**
 * Scan to pay (PP-send-request-11): read a QR code from the camera or from an image, and open the pay target it
 * names. Only this app's own `/pay/send` links count; Send then asks identity who a signed code pays, so a forged
 * code is refused there (`identity.qr_invalid`), never here.
 */

/** Why a scan opened nothing. Each one is shown with its own words and this code. */
export type ScanRefusal =
  'scan.camera_denied' | 'scan.camera_unavailable' | 'scan.not_image' | 'scan.image_too_large' | 'scan.unreadable' | 'scan.not_pay_code';

export class ScanError extends Error {
  constructor(readonly code: ScanRefusal) {
    super(code);
    this.name = 'ScanError';
  }
}

/** A photo of a code is small; anything past this is refused before it is read. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** Images are read at most this many pixels on their long side, enough for any code a phone shows. */
const READ_SIDE = 1600;

/** The Send path a scanned text opens, or `scan.not_pay_code` when it is not one of this app's pay links. */
export function payTarget(text: string, origin: string): string {
  const request = parseRequestLink(text, origin);
  if (!request) throw new ScanError('scan.not_pay_code');
  return requestPath(request);
}

type Detector = { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> };
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};

let detector: Promise<Detector | null> | null = null;

/** The browser's own barcode reader when it reads QR codes, else null (jsQR reads the pixels instead). */
function browserDetector(): Promise<Detector | null> {
  detector ??= (async () => {
    const Barcode = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
    if (!Barcode) return null;
    try {
      return (await Barcode.getSupportedFormats()).includes('qr_code') ? new Barcode({ formats: ['qr_code'] }) : null;
    } catch {
      return null;
    }
  })();
  return detector;
}

/** The text of the QR code in `source` (an image or a video frame) `width` × `height` pixels, or null. */
export async function readCode(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  const browser = await browserDetector();
  if (browser) {
    try {
      const [found] = await browser.detect(source);
      if (found?.rawValue) return found.rawValue;
    } catch {
      // Fall through to reading the pixels.
    }
  }
  const scale = Math.min(1, READ_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, w, h);
  const { data } = context.getImageData(0, 0, w, h);
  return jsQR(data, w, h)?.data ?? null;
}

/** The pay target in an image file: refused when it is not an image, too large, unreadable or not a pay code. */
export async function scanImage(file: Blob, origin: string): Promise<string> {
  if (!file.type.startsWith('image/')) throw new ScanError('scan.not_image');
  if (file.size > IMAGE_MAX_BYTES) throw new ScanError('scan.image_too_large');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ScanError('scan.unreadable');
  }
  try {
    const text = await readCode(bitmap, bitmap.width, bitmap.height);
    if (!text) throw new ScanError('scan.unreadable');
    return payTarget(text, origin);
  } finally {
    bitmap.close();
  }
}

/** The camera's refusal as a scan refusal: a person or a policy said no, or there is no camera to use. */
export function cameraRefusal(err: unknown): ScanRefusal {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'scan.camera_denied' : 'scan.camera_unavailable';
}
