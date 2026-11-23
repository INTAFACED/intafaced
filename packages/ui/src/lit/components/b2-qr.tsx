/**
 * Owner: lane B2 (templates). QrCode: a code a phone can scan, drawn from the kit's own encoder (`qr-encode.ts`, no
 * dependency). Dark modules on a light ground in every theme, Volt's dark page included: a scanner needs that
 * contrast, so the ground and the modules are the kit's one fixed pair (templates.css, `.lt-qr`).
 */
import * as React from 'react';
import { encodeQr, qrPath, type QrEcc } from './qr-encode.js';
import type { DataMarks } from './b2-table.js';

/**
 * A QR code for `value` (a payment link, an address, an EIP-681 request), named by `label` for a screen reader and
 * at a bounded size (`sm` 11rem, `md` 13rem; never wider than its column). The light quiet zone of four modules is part
 * of the drawing, so it scans on any page. `showValue` writes the encoded text under the code, selectable; the text is
 * always on the figure as `data-value`. A text too long for any QR version draws `failed` (an alert), never a code.
 */
export function QrCode({
  value,
  label,
  failed,
  size = 'md',
  ecc = 'M',
  showValue = false,
  marks,
}: {
  value: string;
  label: string;
  failed: React.ReactNode;
  size?: 'sm' | 'md';
  ecc?: QrEcc;
  showValue?: boolean;
  marks?: DataMarks;
}) {
  const drawn = React.useMemo(() => {
    try {
      return qrPath(encodeQr(value, ecc), 4);
    } catch {
      return null;
    }
  }, [value, ecc]);
  if (!drawn)
    return (
      <p className="lt-qr-failed" role="alert" {...marks}>
        {failed}
      </p>
    );
  return (
    <figure className="lt-qr" data-size={size} data-value={value} {...marks}>
      <svg viewBox={`0 0 ${drawn.size} ${drawn.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
        {/* The fills are on the drawing as well as in templates.css, so the code still scans once it leaves the page
            (copied, saved, printed, or read by a scanner from the SVG alone). */}
        <rect
          className="lt-qr-ground"
          width={drawn.size}
          height={drawn.size}
          fill="white" // look-drift-allow: a scanner needs the fixed light ground in the drawing itself, outside the page's CSS
        />
        <path
          className="lt-qr-modules"
          d={drawn.d}
          fill="black" // look-drift-allow: a scanner needs the fixed dark modules in the drawing itself, outside the page's CSS
        />
      </svg>
      {showValue ? (
        <figcaption className="lt-qr-value" dir="ltr">
          {value}
        </figcaption>
      ) : null}
    </figure>
  );
}

export { encodeQr, qrCapacity, qrPath, type QrEcc } from './qr-encode.js';
