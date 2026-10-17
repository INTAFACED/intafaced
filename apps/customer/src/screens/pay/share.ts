/** Small browser helpers for links: the full address of a path, copy to clipboard, and the share sheet. */
export const absoluteLink = (path: string): string => `${location.origin}${path}`;

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const canShare = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/** Opens the device share sheet. A person closing it is not a failure. */
export async function shareLink(url: string, title: string): Promise<'shared' | 'cancelled' | 'failed'> {
  try {
    await navigator.share({ title, url });
    return 'shared';
  } catch (error) {
    return error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}
