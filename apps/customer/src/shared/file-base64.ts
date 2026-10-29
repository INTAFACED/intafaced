/** Reads a file as base64 without its data-URL prefix, for an upload sent inside a JSON body. */
export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/** Bytes as whole KiB, rounded up, as the page names a file size or a cap. */
export const kib = (bytes: number) => Math.ceil(bytes / 1024);
