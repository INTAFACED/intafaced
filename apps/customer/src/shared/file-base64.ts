/** Reads a file (or a captured frame) as base64 without its data-URL prefix, for an upload sent inside a JSON body. */
export function base64Of(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/** Bytes as whole KiB, rounded up, as the page names a file size or a cap. */
export const kib = (bytes: number) => Math.ceil(bytes / 1024);

/** Today on the person's own calendar, as a date input's value. */
export function localToday(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
