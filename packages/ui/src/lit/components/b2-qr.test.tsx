import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QrCode, qrCapacity } from './b2-qr.js';
import { encodeQr } from './qr-encode.js';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('qr code', () => {
  it('draws a named code on its own light ground, with a four-module quiet zone and its text on the figure', () => {
    const value = 'https://example.test/pay/link/abc';
    const out = html(<QrCode value={value} label="Scan to pay" failed="Too long" marks={{ 'data-testid': 'pay-qr' }} />);
    const modules = encodeQr(value, 'M').length;
    const size = modules + 8;
    expect(out).toContain(`<figure class="lt-qr" data-size="md" data-value="${value}" data-testid="pay-qr">`);
    expect(out).toContain(`<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Scan to pay" shape-rendering="crispEdges">`);
    // The ground covers the whole drawing, quiet zone included, so the code scans on a dark page.
    // Its fills are on the drawing itself, so the SVG alone (copied, saved, read by a scanner) is still light on dark.
    expect(out).toContain(`<rect class="lt-qr-ground" width="${size}" height="${size}" fill="white"></rect>`);
    expect(out).toMatch(/<path class="lt-qr-modules" d="M4,4h7v1h-7z[^"]*" fill="black"><\/path>/);
    expect(out).not.toContain('figcaption');
  });

  it('writes the encoded text under the code when asked, and takes the small size', () => {
    const out = html(<QrCode value="0xabc" label="Your address" failed="x" size="sm" showValue />);
    expect(out).toContain('data-size="sm"');
    expect(out).toContain('<figcaption class="lt-qr-value" dir="ltr">0xabc</figcaption>');
  });

  it('draws its failure line, never a code, for a text no QR version holds', () => {
    const out = html(
      <QrCode
        value={'x'.repeat(qrCapacity('M') + 1)}
        label="Scan"
        failed="This link is too long for a code."
        marks={{ 'data-testid': 'q' }}
      />,
    );
    expect(out).toBe('<p class="lt-qr-failed" role="alert" data-testid="q">This link is too long for a code.</p>');
  });

  it('takes a stronger error-correction level', () => {
    const at = (ecc: 'L' | 'H') => /viewBox="0 0 (\d+)/.exec(html(<QrCode value={'x'.repeat(20)} label="s" failed="f" ecc={ecc} />))?.[1];
    expect(Number(at('H'))).toBeGreaterThan(Number(at('L')));
  });
});
