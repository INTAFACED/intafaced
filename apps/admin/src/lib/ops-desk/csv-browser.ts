/** Hand a CSV to the browser as a download. Same-origin and local: the text never leaves the page. */

const BOM = '﻿';

export function downloadCsv(filename: string, text: string): boolean {
  try {
    // The byte order mark makes Excel read the file as UTF-8 instead of guessing a code page.
    const url = URL.createObjectURL(new Blob([BOM, text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}
