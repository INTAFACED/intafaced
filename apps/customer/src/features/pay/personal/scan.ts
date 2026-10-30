import jsQR from 'jsqr';
import { parseRequestLink, requestPath } from './personal-model';

/**
 * Scan to pay (PP-send-request-11): read a QR code from the camera or from an image, and open the pay target it
 * names. Only a full link to this app's own `/pay/send` counts. Send opens filled in for the payer to check, as the
 * link itself would: a signed code is asked of identity there, so a forged one is refused (`identity.qr_invalid`).
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
  // A bare path is not a link to this app: only a full URL on this origin opens anything.
  try {
    new URL(text.trim());
  } catch {
    throw new ScanError('scan.not_pay_code');
  }
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
/** One canvas for every read, so a camera read four times a second allocates nothing new. */
let canvas: HTMLCanvasElement | null = null;

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
  canvas ??= document.createElement('canvas');
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, w, h);
  const { data } = context.getImageData(0, 0, w, h);
  return jsQR(data, w, h)?.data ?? null;
}

/**
 * The pay target in an image file: refused when it is not an image, too large, unreadable or not a pay code. The size
 * cap bounds the decode: the image is decoded once at its own size, as the browser does to show it.
 */
export async function scanImage(file: Blob, origin: string): Promise<string> {
  // Some browsers give a photo no type at all; that one is decoded, and refused as unreadable when it is not an image.
  if (file.type !== '' && !file.type.startsWith('image/')) throw new ScanError('scan.not_image');
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
