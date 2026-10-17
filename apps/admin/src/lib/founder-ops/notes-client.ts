import { founderMutationHeaders } from '@/lib/founder-browser';
import type { OperatorNote } from './notes';

/** Browser hop to `/api/merchants/notes`. The CSRF nonce is fetched per call; no token is ever stored. */
export type NotesReply =
  | { readonly ok: true; readonly note: OperatorNote }
  | { readonly ok: false; readonly title: string; readonly body: string; readonly next: string };

const fail = (title: string, body: string, next: string): NotesReply => ({ ok: false, title, body, next });

export type NotesRequest =
  | { action: 'add'; merchantId: string; body: string; tags: string[]; flagged: boolean }
  | { action: 'retract'; noteId: string; reason: string };

export async function postNotes(request: NotesRequest, signal?: AbortSignal): Promise<NotesReply> {
  let headers: Record<string, string>;
  try {
    headers = await founderMutationHeaders();
  } catch (error) {
    return fail(
      'You are signed out',
      error instanceof Error ? error.message : 'Your founder session is unavailable.',
      'Sign in again. Nothing was saved.',
    );
  }
  try {
    const res = await fetch('/api/merchants/notes', {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      cache: 'no-store',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      note?: OperatorNote;
      refusal?: { title?: string; body?: string; next?: string };
      code?: string;
    } | null;
    if (body?.ok === true && body.note) return { ok: true, note: body.note };
    if (body?.refusal)
      return fail(
        body.refusal.title ?? 'The service refused this',
        body.refusal.body ?? 'Nothing was saved.',
        body.refusal.next ?? 'Try again.',
      );
    if (typeof body?.code === 'string')
      return fail(
        res.status === 401 ? 'You are signed out' : 'Not allowed',
        'The console did not accept your founder session for this action.',
        'Sign out and in again. Nothing was saved.',
      );
    return fail(
      'Could not reach the console',
      'The request did not get through, so nothing was saved.',
      'Check your connection and try again.',
    );
  } catch {
    return fail(
      'Could not reach the console',
      'The request did not get through, so nothing was saved.',
      'Check your connection and try again.',
    );
  }
}
