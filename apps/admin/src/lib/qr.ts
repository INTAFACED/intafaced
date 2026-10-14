import { encode } from 'uqr';

/** The quiet zone round a QR code, in modules. Scanners need four. */
export const QR_QUIET_ZONE = 4;

/** The dark/light grid for `text`, drawn by `uqr` (zero dependencies, MIT). Nothing is sent anywhere: this runs in the browser. */
export function qrModules(text: string): boolean[][] {
  if (!text || text.length > 512) throw new Error('qr: text length');
  // border: 0 because qrPath adds the quiet zone itself.
  return encode(text, { ecc: 'M', border: 0 }).data;
}

/**
 * One SVG path for the dark modules, as horizontal runs, plus the square size in modules (quiet zone included). Rendering the
 * path ourselves, rather than injecting the library's SVG string, keeps the page free of raw HTML.
 */
export function qrPath(modules: readonly (readonly boolean[])[], border: number = QR_QUIET_ZONE): { size: number; d: string } {
  const size = modules.length + border * 2;
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x += 1;
      parts.push(`M${start + border} ${y + border}h${x - start}v1h-${x - start}z`);
    }
  });
  return { size, d: parts.join('') };
}
