import jsQR from 'jsqr';

/**
 * Scans the QR code the page draws (`pay-qr`), as a camera would: the drawn image is rendered to pixels with a quiet
 * zone and decoded by a QR reader that is not the app's own encoder. Returns the decoded text, or null when it does not
 * read.
 */
export async function scanQr(locator) {
  const pixels = await locator.evaluate(async (box) => {
    const svg = box.querySelector('svg');
    if (!svg) return null;
    const scale = 8;
    const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
    const quiet = 4 * scale;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w * scale + 2 * quiet;
    canvas.height = h * scale + 2 * quiet;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; // look-drift-allow: a scanner needs white paper behind the code, outside the app's look
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, quiet, quiet, w * scale, h * scale);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: data.width, height: data.height, rgba: Array.from(data.data) };
  });
  if (!pixels) return null;
  return jsQR(Uint8ClampedArray.from(pixels.rgba), pixels.width, pixels.height)?.data ?? null;
}
