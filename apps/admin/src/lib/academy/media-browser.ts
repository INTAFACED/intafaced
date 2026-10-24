/** Browser hop for course files. Same-origin BFF only; the CSRF nonce is fetched per change. */
import { founderMutationHeaders } from '@/lib/founder-browser';
import type { MediaDeskReply, MediaView } from './media-model';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export async function fetchItemMedia(itemId: string): Promise<MediaView | null> {
  try {
    const res = await fetch(`/api/academy-media?itemId=${encodeURIComponent(itemId)}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) && typeof body.asOf === 'string' && isRecord(body.media) ? (body as unknown as MediaView) : null;
  } catch {
    return null;
  }
}

const unknown = (body: string): MediaDeskReply => ({
  ok: false,
  title: 'The outcome is not known',
  body,
  next: 'Read the item again before trying again.',
  code: null,
  changed: 'unknown',
});

const signedOut = (error: unknown): MediaDeskReply => ({
  ok: false,
  title: 'You are signed out',
  body: error instanceof Error ? error.message : 'Your founder session is unavailable.',
  next: 'Sign in again. Nothing was changed.',
  code: null,
  changed: 'no',
});

function answerOf(answer: unknown): MediaDeskReply {
  if (isRecord(answer) && answer.ok === true && typeof answer.what === 'string') return answer as unknown as MediaDeskReply;
  if (isRecord(answer) && typeof answer.title === 'string' && typeof answer.body === 'string' && typeof answer.next === 'string')
    return {
      ok: false,
      title: answer.title,
      body: answer.body,
      next: answer.next,
      code: typeof answer.code === 'string' ? answer.code : null,
      changed: answer.changed === 'unknown' ? 'unknown' : 'no',
    };
  return unknown('The console answered in a shape it does not understand.');
}

/** A caption file or a second confirm. A dropped connection is an unknown outcome, never repeated on its own. */
export async function postMediaChange(body: Record<string, unknown>): Promise<MediaDeskReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return signedOut(error);
  }
  try {
    const res = await fetch('/api/academy-media', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return answerOf(await res.json().catch(() => null));
  } catch {
    return unknown('The connection ended before the console answered, so it is not known whether the change was made.');
  }
}

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

/** One file: its SHA-256 here, then its bytes to the console, which declares, uploads and has svc-academy check it. */
export async function uploadCourseFile(itemId: string, kind: 'video' | 'handout', file: File): Promise<MediaDeskReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return signedOut(error);
  }
  let sha256: string;
  try {
    sha256 = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  } catch {
    return {
      ok: false,
      title: 'The file could not be read',
      body: 'This browser could not read the file to fingerprint it, so nothing was sent.',
      next: 'Choose the file again, or try a smaller one.',
      code: null,
      changed: 'no',
    };
  }
  const query = new URLSearchParams({ itemId, kind, fileName: file.name, bytes: String(file.size), sha256 });
  try {
    const res = await fetch(`/api/academy-media/upload?${query.toString()}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': file.type || 'application/octet-stream' },
      body: file,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return answerOf(await res.json().catch(() => null));
  } catch {
    return unknown('The connection ended before the console answered, so it is not known whether the file was stored.');
  }
}
